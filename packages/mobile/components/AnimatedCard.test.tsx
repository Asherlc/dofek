import { render, screen } from "@testing-library/react";
import { Text } from "react-native";
import { describe, expect, it } from "vitest";
import { AnimatedCard } from "./AnimatedCard";

describe("AnimatedCard", () => {
  it("renders children", () => {
    render(
      <AnimatedCard index={0}>
        <Text>Content</Text>
      </AnimatedCard>,
    );
    expect(screen.getByText("Content")).toBeTruthy();
  });

  it("renders title when provided", () => {
    render(
      <AnimatedCard index={0} title="Section">
        <Text>Content</Text>
      </AnimatedCard>,
    );
    expect(screen.getByText("SECTION")).toBeTruthy();
  });
});
