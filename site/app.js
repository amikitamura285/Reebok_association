// 全員共通の「確認済」を保存するApps ScriptのURL(…/exec)。
// 空のままの場合は、確認済はこのブラウザだけに保存されます。
const RELAY_URL = "";

const $ = (selector) => document.querySelector(selector);
const state = { groups: [], checked: new Set() };
const LOCAL_KEY = "reebok-finder-checked";
let checkedOpen = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function normalizeName(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function firstDigit(value) {
  return String(value || "").match(/\d/)?.[0] || "";
}

function buildProductGroups(products) {
  const groups = new Map();
  for (const product of products || []) {
    const key = `${normalizeName(product.englishKey || product.name)}\u0000${firstDigit(product.brandItemNumber || product.brandItemFirstDigit || product.productNumber)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }
  return [...groups.values()]
    .filter((items) => items.length > 1)
    .map((items) => ({ englishKey: items[0].englishKey || normalizeName(items[0].name), main: items[0], related: items.slice(1) }));
}

// メインが確認済でも、あとから加わった関連アイテムが未確認なら、未確認として出す
function isGroupChecked(group) {
  if (!state.checked.has(group.main.productNumber)) return false;
  const related = group.related.map((item) => item.productNumber);
  if (!related.some((code) => state.checked.has(code))) return true;
  return related.every((code) => state.checked.has(code));
}

function renderCard(product, small) {
  return `
    <a class="card-link" href="${escapeHtml(product.url || "#")}" target="_blank" rel="noreferrer">
      <img class="${small ? "card-image-small" : "card-image"}" src="${escapeHtml(product.image || "")}" alt="${escapeHtml(product.name || "Reebok product")}" loading="lazy">
      <div class="card-info">
        <h3 class="card-name">${escapeHtml(product.name || "Reebok")}</h3>
        <div class="card-number">
          <span>${escapeHtml(product.productNumber || "PRODUCT")}</span>
          <span>↗</span>
        </div>
      </div>
    </a>`;
}

function renderProductCards(selector, groups) {
  const container = $(selector);
  if (!container) return;
  container.innerHTML = groups.map((group) => `
    <section class="product-group">
      <article class="card card-main">
        ${renderCard(group.main, false)}
        <label class="check-toggle">
          <input type="checkbox" data-product-number="${escapeHtml(group.main.productNumber || "")}" ${isGroupChecked(group) ? "checked" : ""}>
          <span>確認済</span>
        </label>
      </article>
      ${group.related.length ? `<div class="related-items">${group.related.map((p) => `<article class="card card-related">${renderCard(p, true)}</article>`).join("")}</div>` : ""}
    </section>`).join("");

  container.querySelectorAll("[data-product-number]").forEach((box) => {
    box.addEventListener("change", (event) => {
      const code = event.target.dataset.productNumber;
      if (!code) return;
      // そのとき並んでいた関連アイテムもまとめて確認済にする
      const group = groups.find((g) => g.main.productNumber === code);
      const members = [code, ...(group ? group.related.map((i) => i.productNumber).filter(Boolean) : [])];
      members.forEach((c) => { if (event.target.checked) state.checked.add(c); else state.checked.delete(c); });
      renderProducts();
      saveChecked(members, event.target.checked);
    });
  });
}

function renderProducts() {
  const active = state.groups.filter((g) => !isGroupChecked(g));
  const done = state.groups.filter((g) => isGroupChecked(g));
  renderProductCards("#productGrid", active);

  const toggle = $("#checkedToggle");
  toggle.textContent = checkedOpen ? `確認済を閉じる(${done.length}件)` : `確認済を表示(${done.length}件)`;
  toggle.setAttribute("aria-expanded", String(checkedOpen));
  $("#checkedBody").hidden = !checkedOpen;
  if (checkedOpen) renderProductCards("#checkedProductGrid", done);
  else $("#checkedProductGrid").replaceChildren();

  $("#productEmpty").hidden = active.length > 0;
  $("#checkedEmpty").hidden = done.length > 0;
  $("#productCount").textContent = String(active.length).padStart(2, "0");
}

async function relay(request) {
  const response = request
    ? await fetch(RELAY_URL, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify({ ...request, scope: "relation" }) })
    : await fetch(`${RELAY_URL}?action=checked&scope=relation&v=${Date.now()}`, { cache: "no-store" });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error || "確認済を取得できませんでした。");
  return body.checked || [];
}

async function loadChecked() {
  try {
    const list = RELAY_URL ? await relay() : JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]");
    state.checked = new Set(list);
    renderProducts();
  } catch (error) {
    console.warn("確認済を読み込めませんでした:", error.message);
  }
}

async function saveChecked(codes, checked) {
  if (!RELAY_URL) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify([...state.checked]));
    return;
  }
  try {
    state.checked = new Set(await relay({ action: "check", productNumbers: codes, checked }));
    renderProducts();
  } catch (error) {
    codes.forEach((c) => { if (checked) state.checked.delete(c); else state.checked.add(c); });
    renderProducts();
    alert(`確認済の保存に失敗しました。もう一度お試しください。(${error.message})`);
  }
}

async function loadProducts() {
  try {
    const response = await fetch(`products.json?v=${Date.now()}`, { cache: "no-store" });
    const data = await response.json();
    state.groups = buildProductGroups(data.products || []);
    $("#updatedAt").textContent = data.updatedAt
      ? new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(data.updatedAt))
      : "—";
    $("#scannedCount").textContent = data.scanned ? `${data.scanned} ITEMS SCANNED` : "";
  } catch (error) {
    state.groups = [];
  }
  renderProducts();
}

$("#checkedToggle").addEventListener("click", () => { checkedOpen = !checkedOpen; renderProducts(); });

window.addEventListener("DOMContentLoaded", async () => {
  await loadProducts();
  loadChecked();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadChecked(); });
});
