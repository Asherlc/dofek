// biome-ignore lint/suspicious/noExplicitAny: generic mock annotations retain each test's callable contract.
type CallableVitestMock = import("vitest").Mock<(...args: any[]) => any>;
