import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api.js";

export default function UserDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  function load() {
    api.getUser(id).then(setData).catch((err) => setError(err.message));
  }

  useEffect(load, [id]);

  async function handleAction() {
    if (data.user.status === "pending") await api.approveUser(id);
    else if (data.user.status === "active") await api.banUser(id);
    else await api.unbanUser(id);
    load();
  }

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading...</div>;

  const { user, orders, portfolio } = data;

  return (
    <div>
      <Link to="/users" className="back-link">&larr; Back to users</Link>
      <h2 style={{ marginTop: 0 }}>
        {user.telegram_id} {user.username && <span className="muted">@{user.username}</span>}
      </h2>

      <div className="section">
        <span className={`badge ${user.status}`}>{user.status}</span>{" "}
        {user.role === "admin" && <span className="badge admin">admin</span>}
        <div style={{ marginTop: 12 }}>
          <button className={user.status === "active" ? "danger" : ""} onClick={handleAction}>
            {user.status === "pending" ? "Approve user" : user.status === "active" ? "Ban user" : "Unban user"}
          </button>
        </div>
      </div>

      <div className="section">
        <h2>Settings</h2>
        <table>
          <tbody>
            <tr><td>Solana address</td><td>{user.solana_address || "—"}</td></tr>
            <tr><td>EVM address</td><td>{user.evm_address || "—"}</td></tr>
            <tr><td>Snipe enabled</td><td>{user.snipe_enabled ? "yes" : "no"}</td></tr>
            <tr><td>Snipe size (SOL)</td><td>{user.snipe_size_sol}</td></tr>
            <tr><td>Snipe size (ETH)</td><td>{user.snipe_size_eth}</td></tr>
            <tr><td>Copy target</td><td>{user.copy_target || "—"}</td></tr>
            <tr><td>Copy size ratio</td><td>{user.copy_size_ratio}</td></tr>
            <tr><td>Copy max amount</td><td>{user.copy_max_amount}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Portfolio</h2>
        {portfolio.solana ? (
          portfolio.solana.error ? (
            <div className="error">Solana: {portfolio.solana.error}</div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <div>{portfolio.solana.solBalance.toFixed(4)} SOL</div>
              {portfolio.solana.tokens.map((t) => (
                <div key={t.mint} className="muted">{t.uiAmount} — {t.mint.slice(0, 10)}...</div>
              ))}
            </div>
          )
        ) : (
          <div className="muted">No Solana wallet</div>
        )}
        {portfolio.evm ? (
          portfolio.evm.error ? (
            <div className="error">EVM: {portfolio.evm.error}</div>
          ) : (
            <div>
              <div>{Number(portfolio.evm.ethBalance).toFixed(4)} ETH</div>
              {portfolio.evm.tokens.map((t) => (
                <div key={t.address} className="muted">{Number(t.balance).toFixed(4)} {t.symbol}</div>
              ))}
            </div>
          )
        ) : (
          <div className="muted">No EVM wallet</div>
        )}
      </div>

      <div className="section">
        <h2>Recent orders</h2>
        {orders.length === 0 ? (
          <div className="muted">No orders.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Chain</th><th>Side</th><th>Identifier</th><th>Trigger</th><th>Amount</th><th>Status</th></tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.chain}</td>
                  <td>{o.side}</td>
                  <td>{o.identifier.slice(0, 10)}...</td>
                  <td>{o.direction} {o.trigger_price}</td>
                  <td>{o.amount}</td>
                  <td>{o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
