import { createRequire } from "node:module";
import { Router, type RequestHandler } from "express";
import { env } from "../env.js";
import { openApiDocument } from "./spec.js";

type SwaggerUi = {
  serve: RequestHandler[];
  setup: (
    document?: unknown,
    options?: {
      customSiteTitle?: string;
      swaggerOptions?: Record<string, unknown>;
    },
  ) => RequestHandler;
};

const require = createRequire(import.meta.url);
const swaggerUi = require("swagger-ui-express") as SwaggerUi;

export const apiDocsEnabled = env.nodeEnv !== "production" || env.enableApiDocs;

export const openApiRouter: Router = Router();

if (apiDocsEnabled) {
  openApiRouter.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });

  openApiRouter.use(
    "/docs",
    ...swaggerUi.serve,
    swaggerUi.setup(undefined, {
      customSiteTitle: "OpenGym API",
      swaggerOptions: {
        url: "/api/openapi.json",
        withCredentials: true,
      },
    }),
  );
}
