import { Router } from "express";
import { membersRouter } from "../members/router.js";
import { subscriptionsRouter } from "../subscriptions/router.js";
import { settingsRouter } from "../settings/router.js";
import { auditRouter } from "../audit/router.js";
import { deletionRequestsRouter } from "../deletionRequests/router.js";

/**
 * `/api/admin/*` chain-level routes. Each feature owns its own router; they are
 * mounted here in the original handler registration order.
 */
export const adminRouter: Router = Router();

adminRouter.use(membersRouter);
adminRouter.use(subscriptionsRouter);
adminRouter.use(settingsRouter);
adminRouter.use(auditRouter);
adminRouter.use(deletionRequestsRouter);
