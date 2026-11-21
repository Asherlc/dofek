# Cycling planned vs. recorded intervals

A rider can open an existing cycling activity and read what the recorded
workout prescribed beside the power and timer duration available for a
matched lap. The approved [Paseo artboard](../../../design/cycling-interval-target-comparison/activity-detail.html)
shows the read-only activity-detail section. It uses fictional values and
omits the time-with-power-data column.

## Source and matching

The existing FIT activity import is the proposed source. Garmin FIT describes
how an Activity file can embed its Workout Step messages and how a Lap's
`wkt_step_index` references a step's `message_index`. The first version is
limited to a clean, single-session cycling Activity file with that same-file
link, unambiguous lap boundaries, a fixed-time step and a custom absolute power
target. A file must meet the field requirements regardless of which existing FIT
import path delivered it. A template alone, an unlinked lap, a percentage of
FTP, or a preset zone supplies insufficient evidence for this comparison.
[Garmin FIT Activity files](https://developer.garmin.com/fit/file-types/activity)
· [Garmin FIT Workout files](https://developer.garmin.com/fit/file-types/workout)

Preserve each recorded lap, including distinct repetitions of one step.
Keep a point target as a watt value and a range as both endpoints. The
recorded duration is the lap's FIT timer time. Elapsed boundaries select the
power window. Timer time and planned step time are shown as two observations,
including for shortened laps. Garmin devices can pause a step independently of
the activity timer, so a difference describes recorded time without identifying
the cause. An absent lap supplies no completion evidence.
[Garmin Edge workout controls](https://www8.garmin.com/manuals/webhelp/GUID-28E0106C-B05A-44E9-BF7C-9CB36A596B82/EN-US/GUID-DA139DEC-5B83-410E-ADF5-51880B22FA4B.html)

Use the existing deduplicated cycling power stream and its gap-aware averaging
for the lap. A missing average or timer duration is unknown. A measured zero
remains zero. A point or range and a recorded average are a direct comparison.
The section reports those values and timer differences without a workout grade
or a training recommendation. TrainingPeaks presents the same basic
planned-versus-recorded question as a chart overlay, whose alignment the user
can adjust. Dofek's comparison uses the explicit FIT link.
[TrainingPeaks structured workout comparison](https://help.trainingpeaks.com/hc/en-us/articles/115006049708-How-can-I-compare-my-completed-workout-to-my-planned-structured-workout)

## Application scope

Reuse `fitness.activity_interval`, source attribution, and the existing
canonical activity and cycling metrics paths. Extend the read contract for
point or range, planned time, timer time, and observed power. Keep provider
measurements separate from server-calculated values. Show the section on web
and iOS when an activity has eligible matches. Use existing sync and import
flows. Broad archive replay, a new plan source, and manual workout entry are
outside this plan.

## Source qualification

The approval follows the direction of using existing FIT imports. The two
repository cycling FIT fixtures and the sampled public activity fixtures did
not provide a linked cycling workout. Garmin's official SDK successfully
encoded and decoded a synthetic file with absolute range and point targets,
repeat lap links, and a second lap of 134 timer seconds and 145 elapsed seconds.
That validates the documented representation. The user approved starting with
this SDK fixture. A device-produced example remains unverified and is required
before claiming support for live recordings.
