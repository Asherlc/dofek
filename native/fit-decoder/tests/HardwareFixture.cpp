#include <fstream>
#include <filesystem>
#include <cstring>
#include <iterator>
#include <string>
#include <vector>

#include "fit_device_info_mesg.hpp"
#include "fit_encode.hpp"
#include "fit_crc.hpp"
#include "fit_file_id_mesg.hpp"
#include "fit_lap_mesg.hpp"
#include "fit_record_mesg.hpp"
#include "fit_session_mesg.hpp"
#include "fit_workout_mesg.hpp"
#include "fit_workout_step_mesg.hpp"
#include "fit_weight_scale_mesg.hpp"

int main(int argc, char* argv[]) {
  if (argc != 3) return 2;
  std::fstream file(argv[1], std::ios::in | std::ios::out | std::ios::binary | std::ios::trunc);
  if (!file.is_open()) return 1;
  fit::Encode encoder(fit::ProtocolVersion::V20);
  encoder.Open(file);
  const std::string fixture_mode(argv[2]);
  if (fixture_mode.rfind("recovery-", 0) == 0) {
    fit::FileIdMesg file_id;
    const bool chained_header = fixture_mode.rfind("recovery-chained-", 0) == 0 ||
                                fixture_mode == "recovery-intact-chain";
    const bool non_activity = fixture_mode == "recovery-nonactivity";
    const bool missing_type = fixture_mode == "recovery-missing-type";
    if (!missing_type) {
      file_id.SetType(fixture_mode == "recovery-weight" ? FIT_FILE_WEIGHT
                      : non_activity ? FIT_FILE_SETTINGS
                      : FIT_FILE_ACTIVITY);
    }
    file_id.SetManufacturer(FIT_MANUFACTURER_GARMIN);
    encoder.Write(file_id);
    if (fixture_mode == "recovery-weight") {
      fit::WeightScaleMesg weight;
      weight.SetTimestamp(1000000000);
      weight.SetWeight(75000);
      encoder.Write(weight);
    } else if (fixture_mode != "recovery-empty") {
      fit::RecordMesg record;
      record.SetHeartRate(140);
      if (fixture_mode != "recovery-invalid-timestamp") {
        record.SetTimestamp(1000000000);
      }
      encoder.Write(record);
      if (fixture_mode == "recovery-malformed" || fixture_mode == "recovery-footer-overlap") {
        const std::streampos final_record = file.tellp();
        record.SetTimestamp(1000000001);
        encoder.Write(record);
        if (!encoder.Close()) return 1;
        file.close();
        if (fixture_mode == "recovery-footer-overlap") {
          std::fstream overlap(argv[1], std::ios::in | std::ios::out | std::ios::binary);
          FIT_FILE_HDR header{};
          overlap.read(reinterpret_cast<char*>(&header), sizeof(header));
          header.data_size -= 2;
          header.crc = fit::CRC::Calc16(&header, FIT_STRUCT_OFFSET(crc, FIT_FILE_HDR));
          overlap.seekp(0);
          overlap.write(reinterpret_cast<const char*>(&header), sizeof(header));
          overlap.close();
          std::filesystem::resize_file(argv[1], std::filesystem::file_size(argv[1]) - 2);
          return 0;
        }
        std::fstream corrupt(argv[1], std::ios::in | std::ios::out | std::ios::binary);
        corrupt.seekp(final_record);
        const char undefined_local = 0x0F;
        corrupt.write(&undefined_local, 1);
        return 0;
      }
    }
    if (fixture_mode == "recovery-activity-weight") {
      fit::WeightScaleMesg weight;
      weight.SetTimestamp(1000000001);
      weight.SetWeight(75000);
      encoder.Write(weight);
    }
    const std::streampos data_end = file.tellp();
    if (!encoder.Close()) return 1;
    file.close();
    if (chained_header) {
      std::ifstream input(argv[1], std::ios::binary);
      std::vector<char> segment(std::istreambuf_iterator<char>(input), {});
      FIT_FILE_HDR header{};
      std::memcpy(&header, segment.data(), sizeof(header));
      if (fixture_mode == "recovery-chained-signature") {
        header.data_type[0] = 'X';
      } else if (fixture_mode == "recovery-chained-size") {
        header.header_size = 4;
      }
      header.crc = fit::CRC::Calc16(&header, FIT_STRUCT_OFFSET(crc, FIT_FILE_HDR));
      std::memcpy(segment.data(), &header, sizeof(header));
      std::ofstream output(argv[1], std::ios::binary | std::ios::app);
      output.write(segment.data(), static_cast<std::streamsize>(segment.size()));
      return output.good() ? 0 : 1;
    } else if (fixture_mode == "recovery-invalid-header" ||
               fixture_mode == "recovery-header-signature" ||
               fixture_mode == "recovery-header-protocol" ||
               fixture_mode == "recovery-header-zero-data") {
      std::fstream corrupt(argv[1], std::ios::in | std::ios::out | std::ios::binary);
      FIT_FILE_HDR header{};
      corrupt.read(reinterpret_cast<char*>(&header), sizeof(header));
      if (fixture_mode == "recovery-invalid-header") {
        header.header_size = 4;
      } else if (fixture_mode == "recovery-header-signature") {
        header.data_type[0] = 'X';
      } else if (fixture_mode == "recovery-header-protocol") {
        header.protocol_version = 0xF0;
      } else {
        header.data_size = 0;
      }
      header.crc = fit::CRC::Calc16(&header, FIT_STRUCT_OFFSET(crc, FIT_FILE_HDR));
      corrupt.seekp(0);
      corrupt.write(reinterpret_cast<const char*>(&header), sizeof(header));
    } else if (fixture_mode == "recovery-truncated") {
      std::filesystem::resize_file(argv[1], static_cast<std::uintmax_t>(data_end));
    } else if (fixture_mode == "recovery-crc" || fixture_mode == "recovery-weight" ||
               fixture_mode == "recovery-empty" || fixture_mode == "recovery-nonactivity" ||
               fixture_mode == "recovery-missing-type" ||
               fixture_mode == "recovery-invalid-timestamp" ||
               fixture_mode == "recovery-activity-weight") {
      std::fstream corrupt(argv[1], std::ios::in | std::ios::out | std::ios::binary);
      corrupt.seekg(-1, std::ios::end);
      char byte = 0;
      corrupt.read(&byte, 1);
      byte ^= 0xFF;
      corrupt.seekp(-1, std::ios::end);
      corrupt.write(&byte, 1);
    }
    return 0;
  }
  if (fixture_mode == "workout" || fixture_mode == "workout-no-count" ||
      fixture_mode == "plain-laps" || fixture_mode == "workout-chained") {
    const bool embeds_workout = fixture_mode == "workout" || fixture_mode == "workout-no-count";
    fit::FileIdMesg file_id;
    file_id.SetType(FIT_FILE_ACTIVITY);
    file_id.SetManufacturer(FIT_MANUFACTURER_GARMIN);
    encoder.Write(file_id);
    if (embeds_workout) {
      fit::WorkoutMesg workout;
      workout.SetSport(FIT_SPORT_CYCLING);
      if (fixture_mode != "workout-no-count") {
        workout.SetNumValidSteps(2);
      }
      encoder.Write(workout);
    }
    const FIT_UINT32 target_low[] = {1250, 1260};
    const FIT_UINT32 target_high[] = {1265, 1260};
    for (FIT_MESSAGE_INDEX step_index = 0; step_index < 2; ++step_index) {
      if (!embeds_workout) {
        break;
      }
      fit::WorkoutStepMesg step;
      step.SetMessageIndex(step_index);
      step.SetDurationType(FIT_WKT_STEP_DURATION_TIME);
      step.SetDurationValue(180000);
      step.SetTargetType(FIT_WKT_STEP_TARGET_POWER);
      step.SetTargetValue(0);
      step.SetCustomTargetValueLow(target_low[step_index]);
      step.SetCustomTargetValueHigh(target_high[step_index]);
      encoder.Write(step);
    }
    for (int second = 0; second < 5; ++second) {
      fit::RecordMesg record;
      record.SetTimestamp(1000000000 + second * 120);
      record.SetPower(250);
      encoder.Write(record);
    }
    const FIT_UINT8 lap_step_index[] = {0, 0, 1};
    const FIT_UINT32 lap_start_offset[] = {0, 180, 325};
    const FIT_UINT32 lap_end_offset[] = {180, 325, 505};
    const float lap_timer[] = {180.0F, 134.0F, 180.0F};
    const float lap_elapsed[] = {180.0F, 145.0F, 180.0F};
    for (FIT_MESSAGE_INDEX lap_index = 0; lap_index < 3; ++lap_index) {
      fit::LapMesg lap;
      lap.SetMessageIndex(lap_index);
      lap.SetStartTime(1000000000 + lap_start_offset[lap_index]);
      lap.SetTimestamp(1000000000 + lap_end_offset[lap_index]);
      lap.SetWktStepIndex(lap_step_index[lap_index]);
      lap.SetTotalTimerTime(lap_timer[lap_index]);
      lap.SetTotalElapsedTime(lap_elapsed[lap_index]);
      encoder.Write(lap);
    }
    fit::SessionMesg session;
    session.SetStartTime(1000000000);
    session.SetTimestamp(1000000505);
    session.SetTotalElapsedTime(505.0F);
    session.SetSport(FIT_SPORT_CYCLING);
    encoder.Write(session);
    if (fixture_mode != "workout-chained") {
      return encoder.Close() ? 0 : 1;
    }
    // Chain a standalone Workout file after the lap-only activity: the lap links resolve to
    // steps in a different FIT segment, which is not a same-file link.
    if (!encoder.Close()) return 1;
    file.close();
    const std::string workout_path = std::string(argv[1]) + ".workout";
    {
      std::fstream workout_file(
          workout_path, std::ios::in | std::ios::out | std::ios::binary | std::ios::trunc);
      if (!workout_file.is_open()) return 1;
      fit::Encode workout_encoder(fit::ProtocolVersion::V20);
      workout_encoder.Open(workout_file);
      fit::FileIdMesg workout_file_id;
      workout_file_id.SetType(FIT_FILE_WORKOUT);
      workout_file_id.SetManufacturer(FIT_MANUFACTURER_GARMIN);
      workout_encoder.Write(workout_file_id);
      fit::WorkoutMesg standalone_workout;
      standalone_workout.SetSport(FIT_SPORT_CYCLING);
      standalone_workout.SetNumValidSteps(2);
      workout_encoder.Write(standalone_workout);
      for (FIT_MESSAGE_INDEX step_index = 0; step_index < 2; ++step_index) {
        fit::WorkoutStepMesg step;
        step.SetMessageIndex(step_index);
        step.SetDurationType(FIT_WKT_STEP_DURATION_TIME);
        step.SetDurationValue(180000);
        step.SetTargetType(FIT_WKT_STEP_TARGET_POWER);
        step.SetTargetValue(0);
        step.SetCustomTargetValueLow(target_low[step_index]);
        step.SetCustomTargetValueHigh(target_high[step_index]);
        workout_encoder.Write(step);
      }
      if (!workout_encoder.Close()) return 1;
    }
    std::ifstream workout_input(workout_path, std::ios::binary);
    std::vector<char> workout_segment(std::istreambuf_iterator<char>(workout_input), {});
    std::ofstream output(argv[1], std::ios::binary | std::ios::app);
    output.write(workout_segment.data(), static_cast<std::streamsize>(workout_segment.size()));
    workout_input.close();
    std::filesystem::remove(workout_path);
    return output.good() ? 0 : 1;
  }
  if (std::string(argv[2]) != "no-file-id") {
    fit::FileIdMesg file_id;
    file_id.SetType(FIT_FILE_ACTIVITY);
    file_id.SetManufacturer(FIT_MANUFACTURER_GARMIN);
    file_id.SetProduct(3121);
    file_id.SetSerialNumber(123456);
    encoder.Write(file_id);
  }
  for (int index = 0; index < 501; ++index) {
    fit::DeviceInfoMesg device;
    device.SetDeviceIndex(1);
    if (index == 0) {
      device.SetManufacturer(FIT_MANUFACTURER_GARMIN);
      device.SetSerialNumber(987654);
      device.SetProductName(L"Observed sensor");
    } else {
      device.SetBatteryVoltage(3.0F - (index % 4) * 0.25F);
    }
    if (std::string(argv[2]) == "byte-bound") {
      for (FIT_UINT8 value_index = 0; value_index < 250; ++value_index) {
        device.SetFieldUINT8Value(0, 200, value_index);
        device.SetFieldUINT8Value(1, 200, value_index);
        device.SetFieldUINT8Value(25, 200, value_index);
      }
    }
    encoder.Write(device);
    if (index == 250) {
      fit::RecordMesg record;
      record.SetTimestamp(1000000000);
      record.SetHeartRate(140);
      encoder.Write(record);
    }
  }
  return encoder.Close() ? 0 : 1;
}
