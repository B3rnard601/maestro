import { Connection } from "@solana/web3.js";
import { Provider } from "ethers";
import Database from "better-sqlite3";
import { startWalletWatcher as startSolWatcher, CopyTradeEvent as SolTrade } from "./solanaWalletWatcher.js";
import { startWalletWatcher as startEvmWatcher, CopyTradeEvent as EvmTrade } from "./evmWalletWatcher.js";
import { listCopyFollowers, listAllCopyTargets, UserRow } from "../db/db.js";

interface WatchedTarget {
  stopSol: () => void;
  stopEvm: () => void;
}

/**
 * One subscription per unique target wallet regardless of how many users
 * follow it — a popular target being copy-traded by 50 users still only
 * opens one Solana log subscription and one EVM block listener for that
 * address, not 50. Each trade event fans out to every current follower via
 * a fresh DB read, so adding/removing a follower never touches the watcher.
 */
export class CopyTradeRegistry {
  private watched = new Map<string, WatchedTarget>();

  constructor(
    private db: Database.Database,
    private solConnection: Connection,
    private evmProvider: Provider,
    private onSolTrade: (target: string, followers: UserRow[], trade: SolTrade) => void,
    private onEvmTrade: (target: string, followers: UserRow[], trade: EvmTrade) => void
  ) {}

  /** Call once at startup to pick up any targets already set in the DB from a previous run. */
  loadFromDb() {
    for (const target of listAllCopyTargets(this.db)) {
      this.ensureWatching(target);
    }
  }

  private ensureWatching(target: string) {
    if (this.watched.has(target)) return;
    const stopSol = startSolWatcher(this.solConnection, target, (trade) => {
      const followers = listCopyFollowers(this.db, target);
      if (followers.length > 0) this.onSolTrade(target, followers, trade);
    });
    const stopEvm = startEvmWatcher(this.evmProvider, target, (trade) => {
      const followers = listCopyFollowers(this.db, target);
      if (followers.length > 0) this.onEvmTrade(target, followers, trade);
    });
    this.watched.set(target, { stopSol, stopEvm });
  }

  /** Call after writing a user's copy_target to the DB. */
  addFollower(target: string) {
    this.ensureWatching(target);
  }

  /**
   * Call after clearing a user's copy_target. Stops the watcher only if no
   * other user is still following it.
   */
  removeFollowerIfOrphaned(target: string) {
    const remaining = listCopyFollowers(this.db, target);
    if (remaining.length === 0) {
      this.watched.get(target)?.stopSol();
      this.watched.get(target)?.stopEvm();
      this.watched.delete(target);
    }
  }
}
