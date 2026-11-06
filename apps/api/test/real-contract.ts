import type { GameState as FixtureGameState } from "./fixtures/sim";
import type { GameState as RealGameState } from "../../../packages/sim/src/index";

type Extends<Left, Right> = Left extends Right ? true : false;
type Assert<T extends true> = T;

// Compile-time proof that the test fixture and production workspace package use
// exactly compatible state contracts in both directions.
type FixtureMatchesReal = Assert<Extends<FixtureGameState, RealGameState>>;
type RealMatchesFixture = Assert<Extends<RealGameState, FixtureGameState>>;

export type ContractAssertions = FixtureMatchesReal | RealMatchesFixture;
