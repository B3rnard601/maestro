const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export function getToken() {
  return localStorage.getItem("admin_token");
}

export function setToken(token) {
  localStorage.setItem("admin_token", token);
}

export function clearToken() {
  localStorage.removeItem("admin_token");
}

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Session expired");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

export const api = {
  login: (password) => request("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  getUsers: () => request("/api/users"),
  getUser: (id) => request(`/api/users/${id}`),
  banUser: (id) => request(`/api/users/${id}/ban`, { method: "POST" }),
  unbanUser: (id) => request(`/api/users/${id}/unban`, { method: "POST" }),
  approveUser: (id) => request(`/api/users/${id}/approve`, { method: "POST" }),
  getOrders: (status = "open") => request(`/api/orders?status=${status}`),
  cancelOrder: (id) => request(`/api/orders/${id}`, { method: "DELETE" }),
  getStats: () => request("/api/stats"),
  getWalletImports: () => request("/api/wallet-imports"),
};
