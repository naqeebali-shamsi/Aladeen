import * as React from 'react';
import { Box, Text, useInput } from 'ink';

export interface TextInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  mask?: boolean;
  placeholder?: string;
  prompt?: string;
}

/**
 * Minimal masked-input field. Backspace deletes; Enter submits; Esc cancels.
 * Shows mask ('*') when `mask` is true. Reveals length only.
 */
export const TextInput: React.FC<TextInputProps> = ({
  value,
  onChange,
  onSubmit,
  onCancel,
  mask = false,
  placeholder,
  prompt,
}) => {
  useInput((input, key) => {
    if (key.return) {
      if (value.trim().length > 0) onSubmit();
      return;
    }
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (input) onChange(value + input);
  });

  const display = mask ? '*'.repeat(value.length) : value;

  return (
    <Box>
      {prompt ? <Text color="cyan">{prompt} </Text> : null}
      <Text color="white">{display}</Text>
      {value.length === 0 && placeholder ? (
        <Text dimColor>{placeholder}</Text>
      ) : null}
      <Text color="green" dimColor>_</Text>
    </Box>
  );
};
