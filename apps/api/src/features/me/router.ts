import { Router } from "express";
import { gateScanRouter } from "../gate/router.js";
import { profileRouter } from "./profileRouter.js";
import { activityRouter } from "./activityRouter.js";
import { bodyRouter } from "./bodyRouter.js";
import { freezeRouter } from "./freezeRouter.js";
import { deletionRequestRouter } from "./deletionRequestRouter.js";

export const meRouter: Router = Router();

// US-7 gate scan (POST /gate-scan) lives in features/gate.
meRouter.use(gateScanRouter);

meRouter.use(profileRouter);
meRouter.use(activityRouter);
meRouter.use(bodyRouter);
meRouter.use(freezeRouter);
meRouter.use(deletionRequestRouter);
