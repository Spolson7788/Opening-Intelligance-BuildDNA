import type { Config } from "@netlify/functions";
import { createApp } from "../../src/app";
import { netlifyExpressAdapter } from "./_shared/expressAdapter";

export default netlifyExpressAdapter(createApp());

export const config: Config = {
  path: ["/health", "/api/*"],
};
