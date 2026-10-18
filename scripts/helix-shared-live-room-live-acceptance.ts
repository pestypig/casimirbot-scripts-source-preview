import {
  HELIX_SHARED_LIVE_ROOM_LIVE_ACCEPTANCE_SCHEMA,
  runSharedLiveRoomLiveAcceptance,
} from "./lib/helix-shared-live-room-live-acceptance";

try {
  const report = await runSharedLiveRoomLiveAcceptance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (report.status === "fail") {
    process.exitCode = 1;
  } else if (
    report.status === "partial" &&
    process.env.HELIX_SHARED_ROOM_ACCEPTANCE_REQUIRE_COMPLETE === "1"
  ) {
    process.exitCode = 2;
  }
} catch {
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: HELIX_SHARED_LIVE_ROOM_LIVE_ACCEPTANCE_SCHEMA,
        status: "fail",
        error: "acceptance_configuration_invalid",
        message:
          "The acceptance harness configuration is invalid; no environment values were printed.",
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
