use std::collections::{BTreeMap, VecDeque};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone)]
pub struct Order {
    pub seq: u64,
    pub side: Side,
    pub price: i64,
    pub qty: i64,
    pub client_order_id: String,
}

/// Price-level book with FIFO at each price.
/// - bids: highest price is best bid
/// - asks: lowest price is best ask
#[derive(Debug, Default)]
pub struct OrderBook {
    pub bids: BTreeMap<i64, VecDeque<Order>>,
    pub asks: BTreeMap<i64, VecDeque<Order>>,
}

impl OrderBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a resting order (no matching yet in v1).
    pub fn add(&mut self, order: Order) {
        let levels = match order.side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        };

        levels.entry(order.price).or_insert_with(VecDeque::new).push_back(order);
    }

    /// Derived top-of-book (best price + aggregated qty at that price level).
    pub fn top_of_book(&self) -> (i64, i64, i64, i64) {
        let (best_bid_price, best_bid_qty) = self
            .bids
            .iter()
            .next_back() // highest bid
            .map(|(price, q)| (*price, q.iter().map(|o| o.qty).sum()))
            .unwrap_or((0, 0));

        let (best_ask_price, best_ask_qty) = self
            .asks
            .iter()
            .next() // lowest ask
            .map(|(price, q)| (*price, q.iter().map(|o| o.qty).sum()))
            .unwrap_or((0, 0));

        (best_bid_price, best_bid_qty, best_ask_price, best_ask_qty)
    }
}
