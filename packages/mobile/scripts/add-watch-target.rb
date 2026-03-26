#!/usr/bin/env ruby
# frozen_string_literal: true

# Adds the DofekWatch (watchOS) target to the Xcode project.
#
# This script is idempotent — it exits cleanly if the target already exists.
# It uses the xcodeproj gem (same library CocoaPods uses internally) to safely
# manipulate the pbxproj file without manual UUID generation.
#
# Usage:
#   gem install xcodeproj --user-install
#   ruby packages/mobile/scripts/add-watch-target.rb
#
# The script:
#   1. Creates a DofekWatch native target (watchOS app)
#   2. Adds all Swift source files from DofekWatch/
#   3. Configures build settings for watchOS 10
#   4. Embeds the Watch app in the main Dofek (iOS) target
#   5. Adds a target dependency so the Watch app builds first

require "xcodeproj"

PROJECT_PATH = File.join(__dir__, "..", "ios", "Dofek.xcodeproj")
WATCH_DIR = "DofekWatch"

WATCH_SWIFT_FILES = %w[
  DofekWatchApp.swift
  AccelerometerRecorder.swift
  ContentView.swift
  TransferManager.swift
  WatchSessionDelegate.swift
].freeze

project = Xcodeproj::Project.open(PROJECT_PATH)

# Idempotency: skip if target already exists
if project.targets.any? { |t| t.name == "DofekWatch" }
  puts "DofekWatch target already exists, skipping."
  exit 0
end

# --- Create the Watch target ---
watch_target = project.new_target(
  :application,
  "DofekWatch",
  :watchos,
  "10.0"
)

# --- Add file references and group ---
main_group = project.main_group
watch_group = main_group.new_group("DofekWatch", WATCH_DIR)

# Add Swift source files
WATCH_SWIFT_FILES.each do |filename|
  ref = watch_group.new_file(filename)
  watch_target.source_build_phase.add_file_reference(ref)
end

# Add Info.plist (not in any build phase — referenced via INFOPLIST_FILE setting)
watch_group.new_file("Info.plist")

# Add entitlements (not in any build phase — referenced via CODE_SIGN_ENTITLEMENTS)
watch_group.new_file("DofekWatch.entitlements")

# Add Assets.xcassets to resources
assets_ref = watch_group.new_file("Assets.xcassets")
watch_target.resources_build_phase.add_file_reference(assets_ref)

# --- Add DofekWatch.app to the Products group ---
products_group = project.main_group.find_subpath("Products", false)
if products_group
  products_group.children << watch_target.product_reference
  watch_target.product_reference.move(products_group)
end

# --- Configure build settings ---
shared_settings = {
  "SDKROOT" => "watchos",
  "WATCHOS_DEPLOYMENT_TARGET" => "10.0",
  "PRODUCT_BUNDLE_IDENTIFIER" => "com.dofek.app.watchkitapp",
  "INFOPLIST_FILE" => "#{WATCH_DIR}/Info.plist",
  "CODE_SIGN_ENTITLEMENTS" => "#{WATCH_DIR}/DofekWatch.entitlements",
  "ASSETCATALOG_COMPILER_APPICON_NAME" => "AppIcon",
  "TARGETED_DEVICE_FAMILY" => "4",
  "SWIFT_VERSION" => "5.0",
  "GENERATE_INFOPLIST_FILE" => "NO",
  "ENABLE_PREVIEWS" => "YES",
  "PRODUCT_NAME" => "$(TARGET_NAME)",
  "MARKETING_VERSION" => "1.0",
  "CURRENT_PROJECT_VERSION" => "1",
  "VERSIONING_SYSTEM" => "apple-generic",
  "SWIFT_EMIT_LOC_STRINGS" => "YES",
  "LD_RUNPATH_SEARCH_PATHS" => [
    "$(inherited)",
    "@executable_path/Frameworks",
  ],
}

watch_target.build_configurations.each do |config|
  config.build_settings.merge!(shared_settings)

  if config.name == "Debug"
    config.build_settings["SWIFT_OPTIMIZATION_LEVEL"] = "-Onone"
    config.build_settings["SWIFT_ACTIVE_COMPILATION_CONDITIONS"] = "DEBUG"
  else
    config.build_settings["SWIFT_COMPILATION_MODE"] = "wholemodule"
  end
end

# --- Add "Embed Watch Content" build phase to main Dofek target ---
main_target = project.targets.find { |t| t.name == "Dofek" }
raise "Could not find main Dofek target" unless main_target

embed_phase = main_target.new_copy_files_build_phase("Embed Watch Content")
embed_phase.dst_subfolder_spec = Xcodeproj::Constants::COPY_FILES_BUILD_PHASE_DESTINATIONS[:products_directory]
embed_phase.dst_path = "$(CONTENTS_FOLDER_PATH)/Watch"

build_file = embed_phase.add_file_reference(watch_target.product_reference, true)
# Set attributes: RemoveHeadersOnCopy = 1
build_file.settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }

# --- Add target dependency ---
main_target.add_dependency(watch_target)

# --- Register in project TargetAttributes ---
project_attributes = project.root_object.attributes
target_attributes = project_attributes["TargetAttributes"] ||= {}
target_attributes[watch_target.uuid] = {
  "CreatedOnToolsVersion" => "16.0",
}

# --- Ensure DofekWatch is in the project targets list ---
# (new_target already adds it, but verify)
unless project.root_object.targets.include?(watch_target)
  project.root_object.targets << watch_target
end

# --- Save ---
project.save
puts "DofekWatch target added successfully to #{PROJECT_PATH}"
puts "  - #{WATCH_SWIFT_FILES.length} source files"
puts "  - Embedded in Dofek target via 'Embed Watch Content' phase"
puts "  - Bundle ID: com.dofek.app.watchkitapp"
