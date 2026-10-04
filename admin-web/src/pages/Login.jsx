import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setToken } from "../api.js";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    try {
      const { token } = await api.login(password);
      setToken(token);
      navigate("/");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login-box">
      <h1 style={{ fontSize: 18, marginBottom: 16 }}>maestro admin</h1>
      <form onSubmit={handleSubmit}>
        <label className="muted">Admin password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        {error && <div className="error">{error}</div>}
        <button type="submit">Log in</button>
      </form>
    </div>
  );
}
