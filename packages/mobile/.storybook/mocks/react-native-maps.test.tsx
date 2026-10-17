import { fireEvent, render, screen, within } from "@testing-library/react";
import { act, type ComponentRef, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import MapView, { Marker, Polyline } from "./react-native-maps";

describe("Storybook native-map adapter", () => {
  it("keeps zoom controls and selected details inside the supplied native viewport", () => {
    const view = render(
      <MapView
        style={{ width: 320, height: 280 }}
        initialRegion={{ latitude: 37, longitude: -122, latitudeDelta: 0.02, longitudeDelta: 0.04 }}
        zoomEnabled
      >
        <Marker
          title="Climb"
          coordinate={{ latitude: 37, longitude: -122 }}
          description="Climb details"
        />
      </MapView>,
    );
    const preview = view.container.firstElementChild;
    expect(preview?.getAttribute("style")).toContain("height: 280px");
    const map = preview?.firstElementChild;
    expect(map?.getAttribute("style")).toContain("flex: 1");
    expect(map?.getAttribute("style")).not.toContain("height: 280px");
    expect(screen.getByRole("button", { name: "Zoom in" }).parentElement?.parentElement).toBe(
      preview,
    );
    fireEvent.click(screen.getByRole("button", { name: /Climb, latitude 37, longitude -122/ }));
    const inspection = screen.getByLabelText("Selected map point").parentElement;
    expect(inspection?.parentElement).toBe(preview);
    expect(inspection?.getAttribute("style")).toContain("max-height: 50%");
    expect(screen.getByText("Climb details")).toBeTruthy();
  });

  it("reports readiness after the preview mounts and keeps it ready across viewport refreshes", () => {
    const original = { latitude: 37, longitude: -122, latitudeDelta: 0.02, longitudeDelta: 0.04 };
    const onMapReady = vi.fn(() => {
      expect(
        screen.getByRole("button", { name: "Climb, latitude 37, longitude -122" }),
      ).toBeTruthy();
    });
    const view = render(
      <MapView initialRegion={original} onMapReady={onMapReady}>
        <Marker title="Climb" coordinate={{ latitude: 37, longitude: -122 }} />
      </MapView>,
    );
    expect(onMapReady).toHaveBeenCalledOnce();
    view.rerender(
      <MapView
        initialRegion={original}
        region={{ ...original, longitude: -122.02 }}
        onMapReady={() => onMapReady()}
      >
        <Marker title="Climb" coordinate={{ latitude: 37, longitude: -122 }} />
      </MapView>,
    );
    expect(onMapReady).toHaveBeenCalledOnce();
    expect(
      screen.getByLabelText("Climb, latitude 37, longitude -122").getAttribute("style"),
    ).toContain("left: 100%");
  });

  it("changes the preview viewport through the native region API and reports the new zoom region", () => {
    const map = createRef<ComponentRef<typeof MapView>>();
    const onRegionChangeComplete = vi.fn();
    render(
      <MapView
        ref={map}
        initialRegion={{ latitude: 37, longitude: -122, latitudeDelta: 0.02, longitudeDelta: 0.04 }}
        onRegionChangeComplete={onRegionChangeComplete}
      >
        <Marker title="Climb" coordinate={{ latitude: 37, longitude: -122 }} />
      </MapView>,
    );
    const changed = { latitude: 37, longitude: -122.02, latitudeDelta: 0.02, longitudeDelta: 0.04 };
    act(() => map.current?.animateToRegion(changed, 300));
    expect(
      screen.getByLabelText("Climb, latitude 37, longitude -122").getAttribute("style"),
    ).toContain("left: 100%");
    expect(onRegionChangeComplete).toHaveBeenCalledWith(changed);
  });

  it("positions separate source coordinates within the supplied region", () => {
    render(
      <MapView
        initialRegion={{ latitude: 37, longitude: -122, latitudeDelta: 0.02, longitudeDelta: 0.04 }}
      >
        <Marker title="West climb" coordinate={{ latitude: 37.005, longitude: -122.01 }} />
        <Marker
          title="East area"
          coordinate={{ latitude: 36.995, longitude: -121.99 }}
          description="Area location: Goat Rock · openbeta"
        />
      </MapView>,
    );
    const west = screen.getByLabelText("West climb, latitude 37.005, longitude -122.01");
    const east = screen.getByLabelText(
      "East area, latitude 36.995, longitude -121.99, Area location: Goat Rock · openbeta",
    );
    expect(west.getAttribute("style")).toContain("left: 25%");
    expect(west.getAttribute("style")).toContain("top: 25%");
    expect(east.getAttribute("style")).toContain("left: 75%");
    expect(east.getAttribute("style")).toContain("top: 75%");
    expect(screen.queryByText("Area location: Goat Rock · openbeta")).toBeNull();
    fireEvent.click(east);
    expect(screen.getByText("Area location: Goat Rock · openbeta")).toBeTruthy();
  });

  it("centers one-point previews and renders hostile source text as text", () => {
    const label = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <MapView
        initialRegion={{
          latitude: 37,
          longitude: -122,
          latitudeDelta: 0.005,
          longitudeDelta: 0.005,
        }}
      >
        <Marker coordinate={{ latitude: 37, longitude: -122 }} title={label} />
      </MapView>,
    );
    expect(
      screen.getByLabelText(`${label}, latitude 37, longitude -122`).getAttribute("style"),
    ).toContain("left: 50%");
    expect(
      screen.getByLabelText(`${label}, latitude 37, longitude -122`).getAttribute("style"),
    ).toContain("top: 50%");
    fireEvent.click(screen.getByLabelText(`${label}, latitude 37, longitude -122`));
    expect(within(screen.getByLabelText("Selected map point")).getByText(label)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("honors mount-only initialRegion while controlled region updates the viewport", () => {
    const original = { latitude: 37, longitude: -122, latitudeDelta: 0.02, longitudeDelta: 0.04 };
    const changed = { ...original, longitude: -122.02 };
    const view = render(
      <MapView initialRegion={original}>
        <Marker title="Climb" coordinate={{ latitude: 37, longitude: -122 }} />
      </MapView>,
    );
    view.rerender(
      <MapView initialRegion={changed}>
        <Marker title="Climb" coordinate={{ latitude: 37, longitude: -122 }} />
      </MapView>,
    );
    expect(
      screen.getByLabelText("Climb, latitude 37, longitude -122").getAttribute("style"),
    ).toContain("left: 50%");
    view.rerender(
      <MapView initialRegion={original} region={changed}>
        <Marker title="Climb" coordinate={{ latitude: 37, longitude: -122 }} />
      </MapView>,
    );
    expect(
      screen.getByLabelText("Climb, latitude 37, longitude -122").getAttribute("style"),
    ).toContain("left: 100%");
  });

  it("forwards a hit marker press to the production selection handler at unchanged coordinates", () => {
    const onPress = vi.fn();
    const view = render(
      <MapView
        initialRegion={{ latitude: 37, longitude: -122, latitudeDelta: 0.02, longitudeDelta: 0.04 }}
      >
        <Marker
          identifier="first"
          title="First tick"
          coordinate={{ latitude: 37, longitude: -122.02 }}
          description="Climb location: Swiss Cheese · Mountain Project"
        />
        <Marker
          identifier="repeat"
          title="Repeat tick"
          coordinate={{ latitude: 37, longitude: -122.02 }}
          description="Area location: Goat Rock · OpenBeta"
          onPress={onPress}
        />
      </MapView>,
    );
    const firstDot = screen.getByLabelText(
      "First tick, latitude 37, longitude -122.02, Climb location: Swiss Cheese · Mountain Project",
    );
    const repeatDot = screen.getByLabelText(
      "Repeat tick, latitude 37, longitude -122.02, Area location: Goat Rock · OpenBeta",
    );
    expect(firstDot.getAttribute("style")).toContain("left: 0%");
    expect(repeatDot.getAttribute("style")).toContain("left: 0%");
    expect(screen.queryByLabelText("Selected map point")).toBeNull();
    expect(screen.queryByText("Climb location: Swiss Cheese · Mountain Project")).toBeNull();
    fireEvent.click(firstDot);
    expect(
      within(screen.getByLabelText("Selected map point")).getByText(
        "Climb location: Swiss Cheese · Mountain Project",
      ),
    ).toBeTruthy();
    fireEvent.click(repeatDot);
    expect(onPress).toHaveBeenCalledOnce();
    const details = screen.getByLabelText("Selected map point");
    expect(within(details).getByText("Area location: Goat Rock · OpenBeta")).toBeTruthy();
    expect(within(details).queryByText("First tick")).toBeNull();
    expect(
      view.container
        .querySelector('[aria-label="Selected map point"]')
        ?.parentElement?.getAttribute("style"),
    ).not.toContain("position: absolute");
  });

  it("projects the sensor polyline using the same viewport as its source markers", () => {
    const { container } = render(
      <MapView
        initialRegion={{ latitude: 37, longitude: -122, latitudeDelta: 0.02, longitudeDelta: 0.04 }}
      >
        <Polyline
          coordinates={[
            { latitude: 37.005, longitude: -122.01 },
            { latitude: 36.995, longitude: -121.99 },
          ]}
        />
      </MapView>,
    );
    expect(container.querySelector("polyline")?.getAttribute("points")).toBe("25,25 75,75");
  });
});
