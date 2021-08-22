import {
  Config,
  GroupConfig,
  MangoAccount,
  MangoClient,
  MangoGroup,
} from "@blockworks-foundation/mango-client";
import { Market, OpenOrders, Orderbook } from "@project-serum/serum";
import { Order } from "@project-serum/serum/lib/market";
import {
  Account,
  Commitment,
  Connection,
  PublicKey,
  TransactionSignature,
} from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import fetch from "node-fetch";
import os from "os";

// github issue - https://github.com/blockworks-foundation/mango-client-ts/issues/14

type TokenSymbol = string;
type SpotMarketSymbol = string;
type OpenOrdersAsString = string;

interface OpenOrderForPnl {
  nativeQuantityReleased: number;
  nativeQuantityPaid: number;
  side: "sell" | "buy";
  size: number;
  openOrders: OpenOrdersAsString;
}

export class MarketBalance {
  constructor(
    public baseTokenSymbol: string,
    public orders: number,
    public unsettled: number,
    public quoteTokenSymbol: string,
    public quoteOrders: number,
    public quoteUnsettled: number
  ) {}
}

export class FetchMarketSymbol {
  constructor(public symbol: string) {}
}

export class FetchMarket {
  constructor(public symbols: FetchMarketSymbol[]) {}
}

export class Ticker {
  constructor(
    public symbol: string,
    public price: number,
    public timeMs: number
  ) {}
}

export class Ohlcv {
  constructor(
    public timeS: number,
    public open: number,
    public high: number,
    public low: number,
    public close: number,
    public volume: number
  ) {}
}

type Resolution =
  | "1"
  | "3"
  | "5"
  | "15"
  | "30"
  | "60"
  | "120"
  | "180"
  | "240"
  | "1D";

class EmptyOrderBookError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmptyOrderBookError";
  }
}

/**
 * a simpler more cex-style client with sensible (hopefully ;)) defaults
 */
export class SimpleClient {
  private constructor(
    private groupConfig: GroupConfig,
    private connection: Connection,
    private mangoClient: MangoClient,

    private owner: Account,
    private mangoGroup: MangoGroup
  ) {}

  public static async create() {
    const groupConfig = Config.ids().getGroup(
      "mainnet",
      "mainnet.0"
    ) as GroupConfig;

    const connection = new Connection(
      Config.ids().cluster_urls["mainnet"],
      "processed" as Commitment
    );

    const mangoClient = new MangoClient(connection, groupConfig.mangoProgramId);

    const mangoGroup = await mangoClient.getMangoGroup(groupConfig.publicKey);
    await mangoGroup.loadRootBanks(connection);

    function readKeypair() {
      return JSON.parse(
        process.env.KEYPAIR ||
          fs.readFileSync(os.homedir() + "/.config/solana/id.json", "utf-8")
      );
    }

    const owner = new Account(readKeypair());

    return new SimpleClient(
      groupConfig,
      connection,
      mangoClient,
      owner,
      mangoGroup
    );
  }

  /// private

  private async getMarketForSymbol(
    marketSymbol: SpotMarketSymbol
  ): Promise<Market> {
    const spotMarketConfig = this.groupConfig.spotMarkets.find(
      (market) => market.name === marketSymbol
    );
    if (spotMarketConfig === undefined) {
      throw new Error(`market not found for ${marketSymbol}`);
    }

    const market = await Market.load(
      this.connection,
      spotMarketConfig?.publicKey,
      undefined,
      this.groupConfig.serumProgramId
    );

    return market;
  }

  private async getMangoAccountForOwner(): Promise<MangoAccount> {
    const mangoAccount = await (
      await this.mangoClient.getMangoAccountsForOwner(
        this.mangoGroup,
        this.owner.publicKey
      )
    )[0];
    return mangoAccount;
  }

  private async getOpenOrdersAccountForSymbol(
    marketSymbol: SpotMarketSymbol
  ): Promise<OpenOrders | undefined> {
    const spotMarket = await this.getMarketForSymbol(marketSymbol);
    const marketIndex = this.mangoGroup.getSpotMarketIndex(
      spotMarket.publicKey
    );
    const mangoAccount = await this.getMangoAccountForOwner();
    return mangoAccount.spotOpenOrdersAccounts[marketIndex];
  }

  private async cancelOrder(
    mangoAccount: MangoAccount,
    spotMarket: Market,
    order: Order
  ): Promise<TransactionSignature> {
    return await this.mangoClient.cancelSpotOrder(
      this.mangoGroup,
      mangoAccount,
      this.owner,
      spotMarket,
      order
    );
  }

  private async cancelOrdersForMangoAccount(
    mangoAccount: MangoAccount,
    symbol?: SpotMarketSymbol,
    clientId?: string
  ) {
    let orders;
    let market;

    if (symbol === undefined) {
      for (const spotMarketSymbol of this.groupConfig.spotMarkets.map(
        (spotMarketConfig) => spotMarketConfig.name
      )) {
        market = await this.getMarketForSymbol(spotMarketSymbol);
        orders = await this.getOpenOrders(spotMarketSymbol);
        await orders.map((order) =>
          this.cancelOrder(mangoAccount, market, order)
        );
      }
      return;
    }

    market = await this.getMarketForSymbol(symbol!);
    orders = await this.getOpenOrders(symbol!);
    // note: clientId could not even belong to his margin account
    // in that case ordersToCancel would be empty
    const ordersToCancel =
      clientId !== undefined
        ? orders.filter((o) => o.clientId.toString() === clientId)
        : orders;

    await Promise.all(
      ordersToCancel.map((order) =>
        this.cancelOrder(mangoAccount, market, order)
      )
    );
  }

  /// public

  async placeOrder(
    symbol: SpotMarketSymbol,
    type: "market" | "limit",
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType?: "ioc" | "postOnly" | "limit"
  ): Promise<string> {
    if (!symbol.trim()) {
      throw new Error(`invalid symbol ${symbol}`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`invalid quantity ${quantity}`);
    }
    if ((type === "limit" && !Number.isFinite(price)) || price! <= 0) {
      throw new Error(`invalid price ${price}`);
    }

    if (type === "market") {
      const orderBook = await this.getOrderBook(symbol);
      let acc = 0;
      let selectedOrder;
      if (orderBook.length === 0) {
        throw new EmptyOrderBookError(
          "Empty order book encountered when placing a market order!"
        );
      }
      for (const order of orderBook) {
        acc += order.size;
        if (acc >= quantity) {
          selectedOrder = order;
          break;
        }
      }
      if (side === "buy") {
        price = selectedOrder.price * 1.05;
      } else {
        price = selectedOrder.price * 0.95;
      }
    }

    const spotMarket = await this.getMarketForSymbol(symbol);

    const mangoAccount = await this.getMangoAccountForOwner();

    const clientId = new BN(Date.now());

    orderType = orderType === undefined ? "limit" : orderType;

    await this.mangoClient.placeSpotOrder(
      this.mangoGroup,
      mangoAccount,
      this.mangoGroup.mangoCache,
      spotMarket,
      this.owner,
      side,
      price!,
      quantity,
      orderType
    );

    return clientId.toString();
  }

  async getOpenOrders(
    symbol: SpotMarketSymbol,
    clientId?: string
  ): Promise<Order[]> {
    const openOrderAccount = await this.getOpenOrdersAccountForSymbol(symbol);
    if (openOrderAccount === undefined) {
      return [];
    }

    let orders: Order[] = await this.getOrderBook(symbol);
    orders = orders.filter((o) =>
      openOrderAccount.address.equals(o.openOrdersAddress)
    );

    if (clientId) {
      return orders.filter(
        (o) => o.clientId && o.clientId.toString() === clientId
      );
    }

    return orders;
  }

  async cancelOrders(symbol?: SpotMarketSymbol, clientId?: string) {
    const mangoAccount = await this.getMangoAccountForOwner();
    await this.cancelOrdersForMangoAccount(mangoAccount, symbol, clientId);
  }

  async getTradeHistory(symbol: SpotMarketSymbol): Promise<OpenOrderForPnl[]> {
    if (!symbol.trim()) {
      throw new Error(`invalid symbol ${symbol}`);
    }

    const openOrdersAccount = await this.getOpenOrdersAccountForSymbol(symbol);
    if (openOrdersAccount === undefined) {
      return [];
    }

    // e.g. https://stark-fjord-45757.herokuapp.com/trades/open_orders/G5rZ4Qfv5SxpJegVng5FuZftDrJkzLkxQUNjEXuoczX5
    //     {
    //         "id": 2267328,
    //         "loadTimestamp": "2021-04-28T03:36:20.573Z",
    //         "address": "C1EuT9VokAKLiW7i2ASnZUvxDoKuKkCpDDeNxAptuNe4",
    //         "programId": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    //         "baseCurrency": "BTC",
    //         "quoteCurrency": "USDT",
    //         "fill": true,
    //         "out": false,
    //         "bid": false,
    //         "maker": false,
    //         "openOrderSlot": "6",
    //         "feeTier": "0",
    //         "nativeQuantityReleased": "93207112",
    //         "nativeQuantityPaid": "1700",
    //         "nativeFeeOrRebate": "205508",
    //         "orderId": "9555524110645989995606320",
    //         "openOrders": "G5rZ4Qfv5SxpJegVng5FuZftDrJkzLkxQUNjEXuoczX5",
    //         "clientOrderId": "0",
    //         "uuid": "0040cdbdb0667fd5f75c2538e4097c5090e7b15d8cf9a5e7db7a54c3c212d27a",
    //         "source": "1",
    //         "baseTokenDecimals": 6,
    //         "quoteTokenDecimals": 6,
    //         "side": "sell",
    //         "price": 54948.6,
    //         "feeCost": 0.205508,
    //         "size": 0.0017
    //     }
    const response = await fetch(
      `https://stark-fjord-45757.herokuapp.com/trades/open_orders/${openOrdersAccount.address.toBase58()}`
    );
    const parsedResponse = await response.json();
    const trades: OpenOrderForPnl[] = parsedResponse?.data
      ? parsedResponse.data
      : [];
    return trades
      .filter((trade) =>
        openOrdersAccount.address.equals(new PublicKey(trade.openOrders))
      )
      .map((trade) => ({ ...trade, marketName: symbol }));
  }

  /**
   * returns available markets
   */
  async getMarkets(): Promise<FetchMarket> {
    const fetchMarketSymbols = this.groupConfig.spotMarkets.map(
      (spotMarketConfig) => new FetchMarketSymbol(spotMarketConfig.name)
    );
    return new FetchMarket(fetchMarketSymbols);
  }

  /**
   * returns tickers i.e. symbol, closing price, time of closing price
   */
  async getTickers(symbol?: SpotMarketSymbol): Promise<Ticker[]> {
    let ohlcvs;
    let latestOhlcv;

    const to = Date.now();
    // use a sufficiently large window to ensure that we get data back
    const toMinus20Mins = to - 20 * 60 * 1000;
    const oneMinute = "1";

    if (symbol === undefined) {
      const tickers: Ticker[] = [];
      for (const zymbol of this.groupConfig.spotMarkets.map(
        (spotMarketConfig) => spotMarketConfig.name
      )) {
        ohlcvs = await this.getOhlcv(zymbol, oneMinute, toMinus20Mins, to);
        latestOhlcv = ohlcvs[ohlcvs.length - 1];
        tickers.push(
          new Ticker(zymbol, latestOhlcv.close, latestOhlcv.timeS * 1000)
        );
      }
      return tickers;
    }

    ohlcvs = await this.getOhlcv(symbol, oneMinute, toMinus20Mins, to);
    latestOhlcv = ohlcvs[ohlcvs.length - 1];
    return [new Ticker(symbol, latestOhlcv.close, latestOhlcv.timeS * 1000)];
  }

  async getOrderBook(symbol: SpotMarketSymbol): Promise<Order[]> {
    const market = await this.getMarketForSymbol(symbol);

    const bidData = (await this.connection.getAccountInfo(market.bidsAddress))
      ?.data;
    const bidOrderBook = bidData
      ? Orderbook.decode(market, Buffer.from(bidData))
      : [];
    const askData = (await this.connection.getAccountInfo(market.asksAddress))
      ?.data;
    const askOrderBook = askData
      ? Orderbook.decode(market, Buffer.from(askData))
      : [];
    return [...bidOrderBook, ...askOrderBook];
  }

  /**
   * returns ohlcv in ascending order for time
   */
  async getOhlcv(
    spotMarketSymbol: SpotMarketSymbol,
    resolution: Resolution,
    fromEpochMs: number,
    toEpochMs: number
  ): Promise<Ohlcv[]> {
    const response = await fetch(
      `https://serum-history.herokuapp.com/tv/history` +
        `?symbol=${spotMarketSymbol}&resolution=${resolution}` +
        `&from=${fromEpochMs / 1000}&to=${toEpochMs / 1000}`
    );
    const { t, o, h, l, c, v } = await response.json();
    const ohlcvs: Ohlcv[] = [];
    for (let i = 0; i < t.length; i++) {
      ohlcvs.push(new Ohlcv(t[i], o[i], h[i], l[i], c[i], v[i]));
    }
    return ohlcvs;
  }
}

async function debug() {
  const symbol = "BTC/USDC";

  const simpleClient = await SimpleClient.create();

  await simpleClient.placeOrder(symbol, "limit", "buy", 0.0001, 20000);

  let ordersAfterPlaceOrder = await simpleClient.getOpenOrders(symbol);
  console.log(ordersAfterPlaceOrder);

  await simpleClient.cancelOrders(symbol);

  let ordersAfterCancelOrder = await simpleClient.getOpenOrders(symbol);
  console.log(ordersAfterCancelOrder);

  console.log(await simpleClient.getMarkets());

  console.log(await simpleClient.getTickers());

  const to = Date.now();
  const toMinus20Mins = to - 20 * 60 * 1000;
  console.log(await simpleClient.getOhlcv(symbol, "1", toMinus20Mins, to));

  process.exit();
}

debug();
