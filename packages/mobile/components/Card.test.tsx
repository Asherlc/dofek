import { render, screen } from "@testing-library/react";
import { Text } from "react-native";
import { Card } from "./Card";

describe("Card", () => {
  it("renders children", () => {
    render(
      <Card>
        <Text>Hello</Text>
      </Card>,
    );
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  it("renders title when provided", () => {
    render(
      <Card title="Section Title">
        <Text>Content</Text>
      </Card>,
    );
    expect(screen.getByText("SECTION TITLE")).toBeTruthy();
  });

  it("does not render title when omitted", () => {
    render(
      <Card>
        <Text>Content</Text>
      </Card>,
    );
    expect(screen.queryByTestId("card-title")).toBeNull();
  });
});
