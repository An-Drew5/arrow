# Cross-origin browser requests

Set `CORS_ALLOWED_ORIGINS` to a comma-separated list of exact frontend origins,
including scheme and port where applicable (for example
`https://school.example.com,http://localhost:5173`). Requests from other
browser origins are rejected. Allowed origins receive credentialed CORS headers;
frontend requests that need cookies must use `credentials: "include"`.

The refresh cookie is `HttpOnly`, scoped to `/api/v1/auth`, and currently uses
`SameSite=Strict` (`Secure` in production). Credentialed CORS does not override
cookie `SameSite` rules: when the frontend and API are on different sites, the
browser will not send this cookie, so refresh will not work. Even cookies set to
`SameSite=None; Secure` may be blocked by third-party-cookie restrictions.
Prefer deploying the frontend and API behind the same site, ideally with the
API reverse-proxied under the frontend's origin.
