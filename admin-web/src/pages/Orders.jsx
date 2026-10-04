import React, { useEffect, useState } from "react";
import { api } from "../api.js";

export default function Orders() {
  const [orders, setOrders] = useState(null);
  const [status, setStatus] = useState("open");
  const [error, setError] = useState(null);

  function load() {
    api.getOrders(status).then(setOrders).catch((err) => setError(err.message));
  }

  useEffect(load, [status]);

  async function handleCancel(id) {
    await api.cancelOrder(id);
    load();
  }

  if (error) return <div className="error">{error}</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Orders</h2>
      <div style={{ marginBottom: 12 }}>
        {["open", "filled", "cancelled"].map((s) => (
          <button
            key={s}
            className={s === status ? "" : "ghost"}
            style={{ marginRight: 8 }}
            onClick={() => setStatus(s)}
          >
            {s}
          </button>
        ))}
      </div>
      {!orders ? (
        <div className="muted">Loading...</div>
      ) : orders.length === 0 ? (
        <div className="muted">No {status} orders.</div>
      ) : (
        <table>
          <thead>
            <tr><th>User</th><th>Chain</th><th>Side</th><th>Identifier</th><th>Trigger</th><th>Amount</th>{status === "open" && <th></th>}</tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.user_id}</td>
                <td>{o.chain}</td>
                <td>{o.side}</td>
                <td>{o.identifier.slice(0, 10)}...</td>
                <td>{o.direction} {o.trigger_price}</td>
                <td>{o.amount}</td>
                {status === "open" && (
                  <td><button className="danger" onClick={() => handleCancel(o.id)}>Cancel</button></td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
