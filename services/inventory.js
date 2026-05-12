// services/inventory.js
//
// Controle de estoque do profissional — útil pra fisio (eletrodos, parafina,
// ataduras), nutri (suplementos amostra, materiais de bioimpedância), psicólogo
// (testes, jogos terapêuticos), médico (amostras grátis).
//
// Coleções:
//   therapy_inventory_items/{itemId}      — definição do item + saldo atual
//   therapy_inventory_movements/{movId}   — histórico de entradas/saídas
//
// Modelo do item:
//   itemId, therapistUid (sempre)
//   name           string (até 100 chars)
//   category       string livre (até 50, opcional — ex.: "Eletro", "Suplemento")
//   unit           "unidade" | "caixa" | "kg" | "g" | "litro" | "ml" | "metro" | "outro"
//   currentStock   integer (saldo atual — materializado p/ leitura rápida)
//   minStock       integer (alerta visual quando atingido — 0 = sem alerta)
//   description    string (até 300, opcional)
//   archived       boolean (soft delete pra preservar histórico)
//   createdAt, updatedAt
//
// Modelo do movimento:
//   movId, itemId, therapistUid
//   type        "entrada" | "saida"
//   quantity    integer positivo (sempre)
//   reason      string (até 200, opcional — ex.: "Compra fornecedor X")
//   movDate     timestamp (quando ocorreu, pode ser retroativo)
//   createdAt
//
// Concorrência: atualizar currentStock usa Firestore transaction pra evitar
// race condition (2 saídas simultâneas decrementariam de forma errada se
// fosse update direto).

const VALID_UNITS = new Set([
  "unidade", "caixa", "kg", "g", "litro", "ml", "metro", "outro"
]);

const VALID_MOVEMENT_TYPES = new Set(["entrada", "saida"]);

const NAME_MAX        = 100;
const CATEGORY_MAX    = 50;
const DESCRIPTION_MAX = 300;
const REASON_MAX      = 200;

// Limite sanitário pro stock — número absurdo bloqueia, mas permite estoque
// alto pra quem vende suplementos por exemplo.
const STOCK_MIN = 0;
const STOCK_MAX = 1_000_000;

function isValidUnit(u) { return VALID_UNITS.has(u); }
function isValidMovementType(t) { return VALID_MOVEMENT_TYPES.has(t); }

function isValidStockValue(n) {
  if (typeof n !== "number") return false;
  if (!Number.isInteger(n)) return false;
  if (n < STOCK_MIN || n > STOCK_MAX) return false;
  return true;
}

// Quantidade do movimento: deve ser integer positivo. 0 não faz sentido.
function isValidMovementQuantity(n) {
  if (typeof n !== "number") return false;
  if (!Number.isInteger(n)) return false;
  if (n < 1 || n > STOCK_MAX) return false;
  return true;
}

// Verifica se o item está abaixo do estoque mínimo. minStock=0 desativa alerta.
function isLowStock(item) {
  if (!item) return false;
  if (typeof item.minStock !== "number" || item.minStock <= 0) return false;
  return (item.currentStock || 0) <= item.minStock;
}

// Aplica um movimento ao saldo. Retorna novo saldo ou lança erro se
// saída excede saldo atual. Caller é responsável por usar Firestore
// transaction se precisar de atomicidade.
function applyMovement(currentStock, type, quantity) {
  const cur = typeof currentStock === "number" ? currentStock : 0;
  if (type === "entrada") {
    const next = cur + quantity;
    if (next > STOCK_MAX) {
      const err = new Error("ESTOQUE_LIMITE_EXCEDIDO");
      err.code = "ESTOQUE_LIMITE_EXCEDIDO";
      throw err;
    }
    return next;
  }
  if (type === "saida") {
    const next = cur - quantity;
    if (next < 0) {
      const err = new Error("ESTOQUE_INSUFICIENTE");
      err.code = "ESTOQUE_INSUFICIENTE";
      err.currentStock = cur;
      err.requested = quantity;
      throw err;
    }
    return next;
  }
  const err = new Error("TIPO_MOVIMENTO_INVALIDO");
  err.code = "TIPO_MOVIMENTO_INVALIDO";
  throw err;
}

module.exports = {
  VALID_UNITS,
  VALID_MOVEMENT_TYPES,
  NAME_MAX,
  CATEGORY_MAX,
  DESCRIPTION_MAX,
  REASON_MAX,
  STOCK_MIN,
  STOCK_MAX,
  isValidUnit,
  isValidMovementType,
  isValidStockValue,
  isValidMovementQuantity,
  isLowStock,
  applyMovement
};
