use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};

use crate::order_book::{Order, OrderBook, RestingOrder, Side as BookSide};
use crate::EngineState;

/// One WAL line = one accepted order.
/// Stored as JSONL (one JSON object per line).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalEntry {
    pub seq: u64,
    pub symbol: String,
    pub side: String, // "BUY" | "SELL"
    pub price: i64,
    pub qty: i64,
    pub client_order_id: String,
}

/// Snapshot stores full engine state at a point in time.
/// We keep it simple: seq + per-symbol list of resting orders.
/// NOTE: Snapshot is only about resting book state. Matching during replay is fine
/// because we replay WAL entries *after* snapshot seq.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub seq: u64,
    pub books: Vec<SnapshotBook>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotBook {
    pub symbol: String,
    // Snapshot stores RESTING orders in FIFO order grouped by price-level in OrderBook.
    // We serialize as `Order` for compatibility, where `qty` represents remaining qty at snapshot time.
    pub bids: Vec<Order>,
    pub asks: Vec<Order>,
}

/// Startup / restore observability stats.
#[derive(Debug, Clone)]
pub struct RestoreStats {
    pub snapshot_present: bool,
    pub snapshot_seq: u64,
    pub snapshot_books: usize,
    pub snapshot_orders: usize,
    pub wal_replayed: usize,
    pub wal_after_seq: u64,
}

#[derive(Debug, Clone)]
pub struct Wal {
    path: PathBuf,
    snapshot_path: PathBuf,
}

impl Wal {
    pub fn truncate_wal(&self) -> io::Result<()> {
        self.ensure_parent_dir()?;

        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)?;

        Ok(())
    }

    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        let path = path.as_ref().to_path_buf();

        // Default snapshot path: same dir as WAL, file "snapshot.json"
        let snapshot_path = path
            .parent()
            .map(|p| p.join("snapshot.json"))
            .unwrap_or_else(|| PathBuf::from("snapshot.json"));

        Self { path, snapshot_path }
    }

    fn ensure_parent_dir_for(path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        Ok(())
    }

    fn ensure_parent_dir(&self) -> io::Result<()> {
        Self::ensure_parent_dir_for(&self.path)
    }

    fn ensure_snapshot_parent_dir(&self) -> io::Result<()> {
        Self::ensure_parent_dir_for(&self.snapshot_path)
    }

    /// Append one entry as JSONL.
    pub fn append(&self, entry: &WalEntry) -> io::Result<()> {
        self.ensure_parent_dir()?;

        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;

        let line = serde_json::to_string(entry)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        f.write_all(line.as_bytes())?;
        f.write_all(b"\n")?;
        f.flush()?;
        Ok(())
    }

    /// Write a full snapshot of the current EngineState.
    /// This is atomic-ish: write temp file then rename.
    pub fn write_snapshot(&self, st: &EngineState) -> io::Result<()> {
        self.ensure_snapshot_parent_dir()?;

        let snap = Snapshot {
            seq: st.seq,
            books: st
                .books
                .iter()
                .map(|(symbol, book)| SnapshotBook {
                    symbol: symbol.clone(),
                    bids: flatten_side(&book.bids),
                    asks: flatten_side(&book.asks),
                })
                .collect(),
        };

        let json = serde_json::to_vec_pretty(&snap)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let tmp = self.snapshot_path.with_extension("json.tmp");

        {
            let mut f = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)?;
            f.write_all(&json)?;
            f.write_all(b"\n")?;
            f.flush()?;
        }

        // Best-effort atomic replace on POSIX
        fs::rename(tmp, &self.snapshot_path)?;
        Ok(())
    }

    /// Read snapshot if it exists.
    pub fn read_snapshot(&self) -> io::Result<Option<Snapshot>> {
        if !self.snapshot_path.exists() {
            return Ok(None);
        }

        let f = OpenOptions::new().read(true).open(&self.snapshot_path)?;
        let mut reader = BufReader::new(f);
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf)?;

        let snap: Snapshot = serde_json::from_slice(&buf).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("snapshot parse error: {}", e),
            )
        })?;

        Ok(Some(snap))
    }

    /// Replay snapshot (if present) + WAL entries after snapshot seq into EngineState.
    /// Sets st.seq to max seq observed so new orders continue monotonically.
    ///
    /// Returns restore stats for clean startup logging.
    pub fn replay_into_with_stats(&self, st: &mut EngineState) -> io::Result<RestoreStats> {
        // 1) load snapshot if present
        let mut snapshot_present = false;
        let mut snapshot_seq = 0u64;
        let mut snapshot_books = 0usize;
        let mut snapshot_orders = 0usize;

        if let Some(snap) = self.read_snapshot()? {
            snapshot_present = true;
            snapshot_seq = snap.seq;
            let (b, o) = apply_snapshot(st, snap)?;
            snapshot_books = b;
            snapshot_orders = o;
        }

        // 2) replay WAL entries after snapshot seq
        let wal_after_seq = snapshot_seq;
        let wal_replayed = self.replay_wal_after_seq_into(st, wal_after_seq)?;

        Ok(RestoreStats {
            snapshot_present,
            snapshot_seq,
            snapshot_books,
            snapshot_orders,
            wal_replayed,
            wal_after_seq,
        })
    }

    fn replay_wal_after_seq_into(&self, st: &mut EngineState, after_seq: u64) -> io::Result<usize> {
        if !self.path.exists() {
            return Ok(0);
        }

        let f = OpenOptions::new().read(true).open(&self.path)?;
        let reader = BufReader::new(f);

        let mut applied = 0usize;

        for (idx, line) in reader.lines().enumerate() {
            let line = line?;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let entry: WalEntry = serde_json::from_str(line).map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("WAL parse error at line {}: {}", idx + 1, e),
                )
            })?;

            // skip anything already covered by snapshot
            if entry.seq <= after_seq {
                continue;
            }

            if entry.seq > st.seq {
                st.seq = entry.seq;
            }

            let side = match entry.side.as_str() {
                "BUY" => BookSide::Buy,
                "SELL" => BookSide::Sell,
                other => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("invalid side '{}' at line {}", other, idx + 1),
                    ))
                }
            };

            let book: &mut OrderBook = st
                .books
                .entry(entry.symbol.clone())
                .or_insert_with(OrderBook::new);

            // Apply order exactly as it was accepted (matching included).
            let _fills = book.add(Order {
                seq: entry.seq,
                side,
                price: entry.price,
                qty: entry.qty,
                client_order_id: entry.client_order_id.clone(),
            });

            applied += 1;
        }

        Ok(applied)
    }

    /// Expose paths for debugging / tests if needed.
    pub fn wal_path(&self) -> &Path {
        &self.path
    }

    pub fn snapshot_path(&self) -> &Path {
        &self.snapshot_path
    }
}

// ---- Helpers ----

fn flatten_side(levels: &std::collections::BTreeMap<i64, std::collections::VecDeque<RestingOrder>>) -> Vec<Order> {
    // Deterministic order:
    // - iterate price levels in ascending price order (BTreeMap iter)
    // - within each level, FIFO order (VecDeque front -> back)
    //
    // Snapshot serializes as `Order` for compatibility; `qty` stores remaining qty.
    let mut out = Vec::new();
    for (_price, q) in levels.iter() {
        for ro in q.iter() {
            out.push(Order {
                seq: ro.seq,
                side: ro.side,
                price: ro.price,
                qty: ro.remaining_qty,
                client_order_id: ro.client_order_id.clone(),
            });
        }
    }
    out
}

fn apply_snapshot(st: &mut EngineState, snap: Snapshot) -> io::Result<(usize, usize)> {
    st.seq = snap.seq;
    st.books.clear();

    let mut books = 0usize;
    let mut orders = 0usize;

    for b in snap.books.into_iter() {
        let mut book = OrderBook::new();

        // Rebuild bids/asks exactly as resting orders.
        // Push them back into exact price levels, preserving FIFO.
        for o in b.bids.into_iter() {
            orders += 1;
            book.bids
                .entry(o.price)
                .or_insert_with(std::collections::VecDeque::new)
                .push_back(o.into());
        }
        for o in b.asks.into_iter() {
            orders += 1;
            book.asks
                .entry(o.price)
                .or_insert_with(std::collections::VecDeque::new)
                .push_back(o.into());
        }

        st.books.insert(b.symbol, book);
        books += 1;
    }

    Ok((books, orders))
}
