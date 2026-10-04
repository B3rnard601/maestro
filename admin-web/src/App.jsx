import React from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import { getToken, clearToken } from "./api.js";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Users from "./pages/Users.jsx";
import UserDetail from "./pages/UserDetail.jsx";
import Orders from "./pages/Orders.jsx";

function RequireAuth({ children }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return children;
}

function Shell({ children }) {
  return (
    <div className="layout">
      <div className="sidebar">
        <h1>maestro admin</h1>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/users">Users</NavLink>
          <NavLink to="/orders">Orders</NavLink>
        </nav>
        <div style={{ marginTop: 24 }}>
          <button className="ghost" onClick={() => { clearToken(); window.location.href = "/login"; }}>
            Log out
          </button>
        </div>
      </div>
      <div className="main">{children}</div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth><Shell><Dashboard /></Shell></RequireAuth>} />
        <Route path="/users" element={<RequireAuth><Shell><Users /></Shell></RequireAuth>} />
        <Route path="/users/:id" element={<RequireAuth><Shell><UserDetail /></Shell></RequireAuth>} />
        <Route path="/orders" element={<RequireAuth><Shell><Orders /></Shell></RequireAuth>} />
      </Routes>
    </BrowserRouter>
  );
}
