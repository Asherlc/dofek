export const trainingSections = [
  { id: "overview", title: "Overview", subtitle: "Training load and weekly volume" },
  { id: "endurance", title: "Endurance", subtitle: "Volume and intensity distribution" },
  { id: "cycling", title: "Cycling", subtitle: "Cycling volume and vertical ascent rate" },
  { id: "running", title: "Running", subtitle: "Running dynamics" },
  { id: "strength", title: "Strength", subtitle: "Volume and progressive overload" },
  { id: "hiking", title: "Hiking", subtitle: "Compare repeated routes" },
  { id: "climbing", title: "Climbing", subtitle: "Grades, strengths and locations" },
  { id: "recovery", title: "Recovery", subtitle: "Compare recent and usual training load" },
] as const;

export type TrainingSection = (typeof trainingSections)[number]["id"];
