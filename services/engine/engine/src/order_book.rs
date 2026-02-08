use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

/// Incoming order as accepted by the engine.
///
/// Notes:
/// - `qty` is the requested quantity (must be > 0).
/// - This type is NOT stored in the book directly (we convert to `RestingOrder` when resting),
///   which prevents accidental “taker qty mutation” bugs from leaking into resting state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub seq: u64,
    pub side: Side,
    pub price: i64,
    pub qty: i64,
    pub client_order_id: String,
}

/// Resting order stored in the order book.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestingOrder {
    pub seq: u64,
    pub side: Side,
    pub price: i64,
    pub remaining_qty: i64,
    pub client_order_id: String,
}

impl From<Order> for RestingOrder {
    fn from(o: Order) -> Self {
        Self {
            seq: o.seq,
            side: o.side,
            price: o.price,
            remaining_qty: o.qty,
            client_order_id: o.client_order_id,
        }
    }
}

/// One fill that happened during matching.
/// (API already exposes this via gRPC in your main.rs mapping.)
#[derive(Debug, Clone)]
pub struct Fill {
    pub maker_seq: u64,
    pub taker_seq: u64,
    pub price: i64,
    pub qty: i64,
}

/// Price-level book with FIFO at each price.
/// - bids: highest price is best bid
/// - asks: lowest price is best ask
#[derive(Debug, Default)]
pub struct OrderBook {
    pub bids: BTreeMap<i64, VecDeque<RestingOrder>>,
    pub asks: BTreeMap<i64, VecDeque<RestingOrder>>,
}

impl OrderBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an order:
    /// - If it crosses the book, match it (price-time priority, FIFO at each level).
    /// - Any remaining qty rests in the book.
    ///
    /// Returns fills (for trade reporting).
    pub fn add(&mut self, order: Order) -> Vec<Fill> {
        // Hard invariants: these should already be validated by the RPC layer,
        // but we guard here too so replay/future code can’t corrupt state.
        if order.qty <= 0 {
            // Reject silently at book level; caller (engine) should have validated already.
            // This avoids infinite loops / negative resting qty.
            debug_assert!(order.qty > 0, "OrderBook::add got qty <= 0");
            return Vec::new();
        }
        if order.price < 0 {
            debug_assert!(order.price >= 0, "OrderBook::add got price < 0");
            return Vec::new();
        }

        let mut fills: Vec<Fill> = Vec::new();

        // Taker remaining qty (mutated during matching)
        let mut remaining = order.qty;

        match order.side {
            Side::Buy => {
                // BUY crosses if buy_price >= best_ask
                while remaining > 0 {
                    let best_ask_price = match self.asks.keys().next().copied() {
                        Some(p) => p,
                        None => break, // no liquidity
                    };

                    if order.price < best_ask_price {
                        break; // not crossing
                    }

                    // Match against FIFO queue at best ask price
                    let mut remove_level = false;
                    {
                        let q = self
                            .asks
                            .get_mut(&best_ask_price)
                            .expect("ask level disappeared");

                        while remaining > 0 {
                            let Some(front) = q.front_mut() else {
                                remove_level = true;
                                break;
                            };

                            // Maker remaining qty must always be > 0
                            debug_assert!(
                                front.remaining_qty > 0,
                                "resting maker has non-positive remaining_qty"
                            );
                            if front.remaining_qty <= 0 {
                                // Defensive: remove corrupt maker and continue.
                                q.pop_front();
                                continue;
                            }

                            let traded = remaining.min(front.remaining_qty);
                            remaining -= traded;
                            front.remaining_qty -= traded;

                            fills.push(Fill {
                                maker_seq: front.seq,
                                taker_seq: order.seq,
                                price: best_ask_price,
                                qty: traded,
                            });

                            if front.remaining_qty == 0 {
                                q.pop_front();
                                continue;
                            }

                            if remaining == 0 {
                                break;
                            }
                        }

                        if q.is_empty() {
                            remove_level = true;
                        }
                    }

                    if remove_level {
                        self.asks.remove(&best_ask_price);
                    }
                }

                // If remaining qty, rest as bid at its limit price
                if remaining > 0 {
                    let resting = RestingOrder {
                        seq: order.seq,
                        side: order.side,
                        price: order.price,
                        remaining_qty: remaining,
                        client_order_id: order.client_order_id.clone(),
                    };

                    self.bids
                        .entry(order.price)
                        .or_insert_with(VecDeque::new)
                        .push_back(resting);
                }
            }

            Side::Sell => {
                // SELL crosses if sell_price <= best_bid
                while remaining > 0 {
                    let best_bid_price = match self.bids.keys().next_back().copied() {
                        Some(p) => p,
                        None => break, // no liquidity
                    };

                    if order.price > best_bid_price {
                        break; // not crossing
                    }

                    // Match against FIFO queue at best bid price
                    let mut remove_level = false;
                    {
                        let q = self
                            .bids
                            .get_mut(&best_bid_price)
                            .expect("bid level disappeared");

                        while remaining > 0 {
                            let Some(front) = q.front_mut() else {
                                remove_level = true;
                                break;
                            };

                            debug_assert!(
                                front.remaining_qty > 0,
                                "resting maker has non-positive remaining_qty"
                            );
                            if front.remaining_qty <= 0 {
                                q.pop_front();
                                continue;
                            }

                            let traded = remaining.min(front.remaining_qty);
                            remaining -= traded;
                            front.remaining_qty -= traded;

                            fills.push(Fill {
                                maker_seq: front.seq,
                                taker_seq: order.seq,
                                price: best_bid_price,
                                qty: traded,
                            });

                            if front.remaining_qty == 0 {
                                q.pop_front();
                                continue;
                            }

                            if remaining == 0 {
                                break;
                            }
                        }

                        if q.is_empty() {
                            remove_level = true;
                        }
                    }

                    if remove_level {
                        self.bids.remove(&best_bid_price);
                    }
                }

                // If remaining qty, rest as ask at its limit price
                if remaining > 0 {
                    let resting = RestingOrder {
                        seq: order.seq,
                        side: order.side,
                        price: order.price,
                        remaining_qty: remaining,
                        client_order_id: order.client_order_id.clone(),
                    };

                    self.asks
                        .entry(order.price)
                        .or_insert_with(VecDeque::new)
                        .push_back(resting);
                }
            }
        }

        fills
    }

    /// Derived top-of-book (best price + aggregated qty at that price level).
    pub fn top_of_book(&self) -> (i64, i64, i64, i64) {
        let (best_bid_price, best_bid_qty) = self
            .bids
            .iter()
            .next_back() // highest bid
            .map(|(price, q)| (*price, q.iter().map(|o| o.remaining_qty).sum()))
            .unwrap_or((0, 0));

        let (best_ask_price, best_ask_qty) = self
            .asks
            .iter()
            .next() // lowest ask
            .map(|(price, q)| (*price, q.iter().map(|o| o.remaining_qty).sum()))
            .unwrap_or((0, 0));

        (best_bid_price, best_bid_qty, best_ask_price, best_ask_qty)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(seq: u64, side: Side, price: i64, qty: i64) -> Order {
        Order {
            seq,
            side,
            price,
            qty,
            client_order_id: format!("c{}", seq),
        }
    }

    #[test]
    fn resting_order_produces_no_fills_and_sits_in_book() {
        let mut book = OrderBook::new();

        let fills = book.add(o(1, Side::Buy, 100, 5));
        assert!(fills.is_empty());

        let (bbp, bbq, bap, baq) = book.top_of_book();
        assert_eq!((bbp, bbq, bap, baq), (100, 5, 0, 0));

        // depth at level exists
        assert_eq!(book.bids.get(&100).unwrap().len(), 1);
        assert_eq!(
            book.bids.get(&100).unwrap().front().unwrap().remaining_qty,
            5
        );
    }

    #[test]
    fn buy_crosses_best_ask_and_partially_fills() {
        let mut book = OrderBook::new();

        // Resting asks
        assert!(book.add(o(1, Side::Sell, 101, 4)).is_empty());
        assert!(book.add(o(2, Side::Sell, 102, 2)).is_empty());

        // Taker buy sweeps 101 fully and 102 partially
        let fills = book.add(o(3, Side::Buy, 102, 5));
        assert_eq!(fills.len(), 2);

        assert_eq!(fills[0].maker_seq, 1);
        assert_eq!(fills[0].taker_seq, 3);
        assert_eq!(fills[0].price, 101);
        assert_eq!(fills[0].qty, 4);

        assert_eq!(fills[1].maker_seq, 2);
        assert_eq!(fills[1].taker_seq, 3);
        assert_eq!(fills[1].price, 102);
        assert_eq!(fills[1].qty, 1);

        // Remaining ask at 102 should be qty=1
        let q = book.asks.get(&102).unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(q.front().unwrap().seq, 2);
        assert_eq!(q.front().unwrap().remaining_qty, 1);

        // No bids should rest (taker fully filled)
        assert!(book.bids.is_empty());

        let (bbp, bbq, bap, baq) = book.top_of_book();
        assert_eq!((bbp, bbq, bap, baq), (0, 0, 102, 1));
    }

    #[test]
    fn sell_crosses_best_bid_and_partially_fills() {
        let mut book = OrderBook::new();

        // Resting bids
        assert!(book.add(o(1, Side::Buy, 100, 3)).is_empty());
        assert!(book.add(o(2, Side::Buy, 99, 4)).is_empty());

        // Taker sell hits 100 fully and 99 partially
        let fills = book.add(o(3, Side::Sell, 99, 5));
        assert_eq!(fills.len(), 2);

        assert_eq!(fills[0].maker_seq, 1);
        assert_eq!(fills[0].taker_seq, 3);
        assert_eq!(fills[0].price, 100);
        assert_eq!(fills[0].qty, 3);

        assert_eq!(fills[1].maker_seq, 2);
        assert_eq!(fills[1].taker_seq, 3);
        assert_eq!(fills[1].price, 99);
        assert_eq!(fills[1].qty, 2);

        // Remaining bid at 99 should be qty=2 (same maker seq=2)
        let q = book.bids.get(&99).unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(q.front().unwrap().seq, 2);
        assert_eq!(q.front().unwrap().remaining_qty, 2);

        // No asks should rest (taker fully filled)
        assert!(book.asks.is_empty());

        let (bbp, bbq, bap, baq) = book.top_of_book();
        assert_eq!((bbp, bbq, bap, baq), (99, 2, 0, 0));
    }

    #[test]
    fn fifo_within_same_price_level() {
        let mut book = OrderBook::new();

        // Two asks at same price, different seq; FIFO says seq=1 fills before seq=2
        assert!(book.add(o(1, Side::Sell, 101, 2)).is_empty());
        assert!(book.add(o(2, Side::Sell, 101, 2)).is_empty());

        let fills = book.add(o(3, Side::Buy, 101, 3));
        assert_eq!(fills.len(), 2);

        // First fill should be against seq=1 for qty 2
        assert_eq!(fills[0].maker_seq, 1);
        assert_eq!(fills[0].price, 101);
        assert_eq!(fills[0].qty, 2);

        // Second fill against seq=2 for qty 1
        assert_eq!(fills[1].maker_seq, 2);
        assert_eq!(fills[1].price, 101);
        assert_eq!(fills[1].qty, 1);

        // Remaining ask should be maker seq=2 with qty=1
        let q = book.asks.get(&101).unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(q.front().unwrap().seq, 2);
        assert_eq!(q.front().unwrap().remaining_qty, 1);
    }

    #[test]
    fn leftover_rests_if_taker_not_fully_filled() {
        let mut book = OrderBook::new();

        // Only 2 available at 101
        assert!(book.add(o(1, Side::Sell, 101, 2)).is_empty());

        // Buy wants 5 at 101 -> fills 2 and rests 3 as bid at 101
        let fills = book.add(o(2, Side::Buy, 101, 5));
        assert_eq!(fills.len(), 1);
        assert_eq!(fills[0].maker_seq, 1);
        assert_eq!(fills[0].taker_seq, 2);
        assert_eq!(fills[0].price, 101);
        assert_eq!(fills[0].qty, 2);

        // asks empty, bids has remaining 3 at 101 with taker seq=2 resting
        assert!(book.asks.is_empty());
        let qb = book.bids.get(&101).unwrap();
        assert_eq!(qb.len(), 1);
        assert_eq!(qb.front().unwrap().seq, 2);
        assert_eq!(qb.front().unwrap().remaining_qty, 3);

        let (bbp, bbq, bap, baq) = book.top_of_book();
        assert_eq!((bbp, bbq, bap, baq), (101, 3, 0, 0));
    }
}
