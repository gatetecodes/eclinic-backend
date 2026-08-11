import type { Handler, Hono } from "hono";
import type { AppEnv } from "../../../../middlewares/auth.middleware.ts";

type VisitRouteRegistrar = (
  path: string,
  ...handlers: Handler<AppEnv>[]
) => void;

export type VisitRouteRegistrars = {
  get: VisitRouteRegistrar;
  post: VisitRouteRegistrar;
  put: VisitRouteRegistrar;
};

export const createVisitRouteRegistrars = (
  router: Hono<AppEnv>
): VisitRouteRegistrars => ({
  get: (path, ...handlers) => {
    router.on("GET", path, ...handlers);
  },
  post: (path, ...handlers) => {
    router.on("POST", path, ...handlers);
  },
  put: (path, ...handlers) => {
    router.on("PUT", path, ...handlers);
  },
});
