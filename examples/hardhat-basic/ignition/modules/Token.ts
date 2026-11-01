import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("TokenModule", (m) => {
  const supply = m.getParameter("supply", 1_000_000n * 10n ** 18n);
  const token = m.contract("HatchToken", ["Hatch Token", "HATCH", supply]);
  const counter = m.contract("Counter");
  m.call(counter, "setNumber", [3]);
  return { token, counter };
});
