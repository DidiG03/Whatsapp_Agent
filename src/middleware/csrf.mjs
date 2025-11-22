import csrf from "csurf";

const isProduction = process.env.NODE_ENV === "production";

export const csrfProtection = csrf({
  cookie: {
    key: "_wa_csrf",
    sameSite: "lax",
    httpOnly: true,
    secure: isProduction,
  }
});

export function attachCsrfToken(req, res, next) {
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

