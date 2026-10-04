import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

export default function Users() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);

  function load() {
    api.getUsers().then(setUsers).catch((err) => setError(err.message));
  }

  useEffect(load, []);

  async function handleAction(user) {
    if (user.status === "pending") await api.approveUser(user.telegram_id);
    else if (user.status === "active") await api.banUser(user.telegram_id);
    else await api.unbanUser(user.telegram_id);
    load();
  }

  if (error) return <div className="error">{error}</div>;
  if (!users) return <div className="muted">Loading...</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Users ({users.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Telegram ID</th>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th>Snipe</th>
            <th>Copy target</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.telegram_id}>
              <td><Link to={`/users/${u.telegram_id}`}>{u.telegram_id}</Link></td>
              <td>{u.username ? `@${u.username}` : "—"}</td>
              <td>{u.role === "admin" ? <span className="badge admin">admin</span> : "user"}</td>
              <td><span className={`badge ${u.status}`}>{u.status}</span></td>
              <td>{u.snipe_enabled ? "on" : "off"}</td>
              <td>{u.copy_target ? `${u.copy_target.slice(0, 10)}...` : "—"}</td>
              <td>
                <button className={u.status === "active" ? "danger" : ""} onClick={() => handleAction(u)}>
                  {u.status === "pending" ? "Approve" : u.status === "active" ? "Ban" : "Unban"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
