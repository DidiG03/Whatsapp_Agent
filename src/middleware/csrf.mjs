import csrf from "csurf";

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";
const csrfDisabled = process.env.CSRF_DISABLED === "1" || isTest;

export const csrfProtection = csrfDisabled
  ? (_req, _res, next) => next()
  : csrf({
      cookie: {
        key: "_wa_csrf",
        sameSite: "lax",
        httpOnly: true,
        secure: isProduction,
      }
    });

export function attachCsrfToken(req, res, next) {
  if (csrfDisabled) {
    res.locals.csrfToken = "";
    return next();
  }
  if (typeof req.csrfToken !== "function") {
    return next();
  }
  try {
    res.locals.csrfToken = req.csrfToken();
    return next();
  } catch (error) {
    return next(error);
  }
}

export default {
  csrfProtection,
  attachCsrfToken
};

