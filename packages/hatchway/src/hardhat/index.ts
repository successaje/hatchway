import type { HardhatPlugin } from "hardhat/types/plugins";

/**
 * Hardhat 3 plugin. Inert unless Hardhat was started by `hatchway hardhat …`, in which case
 * account and signing requests on the selected HTTP network are approved in your browser
 * wallet; every other request goes to the network as usual.
 *
 * ```ts
 * import hatchway from "hatchway/hardhat";
 * export default defineConfig({ plugins: [hatchway] });
 * ```
 */
const hatchwayPlugin: HardhatPlugin = {
  id: "hatchway",
  npmPackage: "hatchway",
  hookHandlers: {
    network: () => import("./network-hooks.js"),
  },
};

export default hatchwayPlugin;
