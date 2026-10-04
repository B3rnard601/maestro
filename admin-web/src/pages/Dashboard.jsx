import React, { useEffect, useState } from "react";
import { api } from "../api.js";

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getStats().then(setStats).catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!stats) return <div className="muted">Loading...</div>;

  const cards = [
    ["Pending approval", stats.pendingUsers],
    ["Total users", stats.totalUsers],
    ["Active", stats.activeUsers],
    ["Banned", stats.bannedUsers],
    ["Auto-buy on", stats.activeSnipers],
    ["Copy-trading", stats.activeCopyTraders],
    ["Open orders", stats.openOrders],
  ];

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Overview</h2>
      <div className="stat-grid">
        {cards.map(([label, value]) => (
          <div className="stat-card" key={label}>
            <div className="value">{value}</div>
            <div className="label">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
