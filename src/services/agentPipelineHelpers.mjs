const RE_GREETING_SIMPLE = /^(hi|hello|hey|yo|hiya|howdy|greetings)\b/;
const RE_GREETING_GOOD = /^good\s+(morning|afternoon|evening)\b/;
const RE_GREETING_SQ = /^(pershendetje|tungjatjeta|tung|tungi|ckemi|c'kemi|miremengjes|miredita|mirembrema|hej|tjeta)\b/;

function stripAccentsLower(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function isGreeting(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return false;
  if (RE_GREETING_SIMPLE.test(s)) return true;
  if (RE_GREETING_GOOD.test(s)) return true;
  if (["hi", "hello", "hey", "yo", "hiya", "howdy", "greetings", "good morning", "good afternoon", "good evening"].includes(s)) {
    return true;
  }
  const sq = stripAccentsLower(s);
  if (RE_GREETING_SQ.test(sq)) return true;
  if (["pershendetje", "tungjatjeta", "tung", "ckemi", "miremengjes", "miredita", "mirembrema"].includes(sq)) {
    return true;
  }
  return false;
}

export default { isGreeting };
