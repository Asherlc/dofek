import { ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { colors } from "../../theme";
import { styles } from "./add-styles.ts";

interface AiMealItem {
  meal: string;
  foodName: string;
  foodDescription: string | null;
  calories: number;
}

interface AiMealTabProps {
  value: string;
  onValueChange: (value: string) => void;
  error: string | null;
  items: AiMealItem[];
  isWide: boolean;
  isAnalyzing: boolean;
  isSaving: boolean;
  onAnalyze: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function AiMealTab({
  value,
  onValueChange,
  error,
  items,
  isWide,
  isAnalyzing,
  isSaving,
  onAnalyze,
  onCancel,
  onConfirm,
}: AiMealTabProps) {
  const isBusy = isAnalyzing || isSaving;

  return (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={[styles.formContent, isWide && styles.contentWide]}
      keyboardShouldPersistTaps="handled"
    >
      <TextInput
        style={styles.aiMealInput}
        value={value}
        onChangeText={onValueChange}
        placeholder="two eggs, toast with butter, and coffee with milk"
        placeholderTextColor={colors.textTertiary}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
        autoFocus
      />
      {error && <Text style={styles.aiMealError}>{error}</Text>}
      <TouchableOpacity
        style={[styles.saveButton, (!value.trim() || isBusy) && styles.saveButtonDisabled]}
        onPress={onAnalyze}
        activeOpacity={0.8}
        disabled={!value.trim() || isBusy}
      >
        <Text style={styles.saveButtonText}>{isBusy ? "Logging..." : "Log with AI"}</Text>
      </TouchableOpacity>

      {items.length > 0 && (
        <View style={styles.aiMealReview}>
          <Text style={styles.aiMealReviewTitle}>Review AI meal</Text>
          {items.map((item) => (
            <View
              key={`${item.meal}-${item.foodName}-${item.foodDescription ?? "no-description"}`}
              style={styles.aiMealReviewItem}
            >
              <View style={styles.aiMealReviewText}>
                <Text style={styles.aiMealReviewName}>{item.foodName}</Text>
                {item.foodDescription && (
                  <Text style={styles.aiMealReviewDescription}>{item.foodDescription}</Text>
                )}
              </View>
              <Text style={styles.aiMealReviewCalories}>{item.calories} cal</Text>
            </View>
          ))}
          <View style={styles.aiMealReviewActions}>
            <TouchableOpacity
              style={styles.aiMealCancelButton}
              onPress={onCancel}
              activeOpacity={0.8}
              disabled={isSaving}
            >
              <Text style={styles.aiMealCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.aiMealConfirmButton, isSaving && styles.saveButtonDisabled]}
              onPress={onConfirm}
              activeOpacity={0.8}
              disabled={isSaving}
            >
              <Text style={styles.aiMealConfirmText}>
                {isSaving ? "Logging..." : "Confirm and log"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </ScrollView>
  );
}
