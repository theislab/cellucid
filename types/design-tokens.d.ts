/**
 * Cellucid design token type definitions.
 *
 * This file is editor-facing only (no runtime impact). It provides autocomplete
 * and typo-prevention when referencing CSS custom properties in JS/TS.
 */

export type PrimitiveColorToken =
  | 'gray-50' | 'gray-100' | 'gray-200' | 'gray-300' | 'gray-400'
  | 'gray-500' | 'gray-600' | 'gray-700' | 'gray-800' | 'gray-900' | 'gray-950'
  | 'cyan-50' | 'cyan-100' | 'cyan-200' | 'cyan-300' | 'cyan-400'
  | 'cyan-500' | 'cyan-600' | 'cyan-700' | 'cyan-800' | 'cyan-900'
  | 'red-50' | 'red-100' | 'red-200' | 'red-300' | 'red-400'
  | 'red-500' | 'red-600' | 'red-700' | 'red-800' | 'red-900' | 'red-950'
  | 'green-50' | 'green-100' | 'green-200' | 'green-300' | 'green-400'
  | 'green-500' | 'green-600' | 'green-700' | 'green-800' | 'green-900'
  | 'blue-50' | 'blue-100' | 'blue-200' | 'blue-300' | 'blue-400'
  | 'blue-500' | 'blue-600' | 'blue-700' | 'blue-800' | 'blue-900'
  | 'yellow-50' | 'yellow-100' | 'yellow-200' | 'yellow-300' | 'yellow-400'
  | 'yellow-500' | 'yellow-600' | 'yellow-700' | 'yellow-800' | 'yellow-900'
  | 'white' | 'black' | 'transparent'
  | 'viewer-bg-grid' | 'viewer-bg-grid-dark'
  | 'viewer-bg-studio' | 'viewer-bg-studio-dark'
  | 'viewer-bg-atelier' | 'viewer-bg-abyss' | 'viewer-bg-aurora'
  | 'viewer-bg-nebula' | 'viewer-bg-abyss-dark' | 'viewer-bg-aurora-dark';

export type SemanticColorToken =
  | 'color-surface-primary' | 'color-surface-secondary' | 'color-surface-tertiary'
  | 'color-surface-elevated' | 'color-surface-sunken' | 'color-surface-overlay' | 'color-surface-inverse'
  | 'color-text-primary' | 'color-text-secondary' | 'color-text-tertiary'
  | 'color-text-inverse' | 'color-text-disabled' | 'color-text-link' | 'color-text-link-hover'
  | 'color-border-strong' | 'color-border-default' | 'color-border-light'
  | 'color-border-focus' | 'color-border-error'
  | 'color-border-subtle' | 'color-border-faint'
  | 'color-interactive-primary' | 'color-interactive-primary-hover' | 'color-interactive-primary-active'
  | 'color-interactive-secondary' | 'color-interactive-secondary-hover' | 'color-interactive-secondary-active'
  | 'color-accent' | 'color-accent-strong' | 'color-accent-soft' | 'color-accent-text'
  | 'color-success' | 'color-success-soft' | 'color-success-text'
  | 'color-warning' | 'color-warning-soft' | 'color-warning-text'
  | 'color-danger' | 'color-danger-soft' | 'color-danger-text' | 'color-danger-dark'
  | 'color-info' | 'color-info-soft' | 'color-info-text';

export type SpacingToken =
  | 'space-0' | 'space-px' | 'space-0-5' | 'space-1' | 'space-1-5'
  | 'space-2' | 'space-2-5' | 'space-3' | 'space-3-5' | 'space-4'
  | 'space-5' | 'space-6' | 'space-7' | 'space-8' | 'space-9'
  | 'space-10' | 'space-11' | 'space-12' | 'space-14' | 'space-16'
  | 'space-20' | 'space-24'
  | 'sidebar-width' | 'sidebar-min-width' | 'sidebar-max-width'
  | 'sidebar-toggle-width' | 'sidebar-toggle-height'
  | 'header-height' | 'accordion-default-width' | 'accordion-default-height';

export type BreakpointToken =
  | 'breakpoint-xs'
  | 'breakpoint-sm'
  | 'breakpoint-md'
  | 'breakpoint-lg'
  | 'breakpoint-xl';

export type TypographyToken =
  | 'font-sans' | 'font-display' | 'font-mono'
  | 'font-weight-regular' | 'font-weight-medium' | 'font-weight-semibold' | 'font-weight-bold'
  | 'text-2xs' | 'text-xs' | 'text-sm' | 'text-md' | 'text-lg' | 'text-xl' | 'text-2xl' | 'text-3xl'
  | 'type-title' | 'type-heading' | 'type-body'
  | 'type-label' | 'type-control'
  | 'type-button' | 'type-hint' | 'type-readout' | 'type-compact'
  | 'tracking-tight' | 'tracking-normal' | 'tracking-wide' | 'tracking-wider'
  | 'leading-none' | 'leading-tight' | 'leading-normal' | 'leading-relaxed';

export type BorderToken =
  | 'border-width-1' | 'border-width-2'
  | 'border-strong' | 'border-default' | 'border-light'
  | 'radius-none' | 'radius-sm' | 'radius-md' | 'radius-lg' | 'radius-xl' | 'radius-2xl' | 'radius-full';

export type ShadowToken =
  | 'shadow-rgb'
  | 'shadow-none'
  | 'shadow-xs' | 'shadow-sm' | 'shadow-md' | 'shadow-lg' | 'shadow-xl'
  | 'shadow-soft-xs' | 'shadow-soft-sm' | 'shadow-soft-md' | 'shadow-soft-lg' | 'shadow-soft-xl';

export type TransitionToken =
  | 'duration-instant' | 'duration-fast' | 'duration-normal' | 'duration-slow' | 'duration-spin'
  | 'easing-linear' | 'easing-standard' | 'easing-smooth' | 'easing-out'
  | 'transition-colors';

export type ZIndexToken =
  | 'z-below' | 'z-base' | 'z-raised'
  | 'z-dropdown' | 'z-sticky' | 'z-overlay' | 'z-sidebar'
  | 'z-floating' | 'z-modal' | 'z-popover' | 'z-tooltip' | 'z-notification'
  | 'z-max';

export type OpacityToken =
  | 'opacity-0' | 'opacity-3' | 'opacity-5' | 'opacity-6' | 'opacity-8' | 'opacity-10'
  | 'opacity-12' | 'opacity-15' | 'opacity-18' | 'opacity-20' | 'opacity-22' | 'opacity-25'
  | 'opacity-30' | 'opacity-35' | 'opacity-40' | 'opacity-45' | 'opacity-50'
  | 'opacity-55' | 'opacity-60' | 'opacity-65' | 'opacity-70' | 'opacity-75'
  | 'opacity-80' | 'opacity-85' | 'opacity-90' | 'opacity-95' | 'opacity-100';

export type ControlToken =
  | 'control-panel-gap' | 'control-group-gap' | 'control-block-gap' | 'control-row-gap'
  | 'control-box-padding-y' | 'control-box-padding-x'
  | 'control-padding-y' | 'control-padding-x'
  | 'control-height' | 'control-compact-height'
  | 'control-button-padding-y' | 'control-button-padding-x'
  | 'control-button-compact-padding-y' | 'control-button-compact-padding-x'
  | 'control-chip-padding-y' | 'control-chip-padding-x'
  | 'control-icon-button-size' | 'control-icon-size' | 'control-check-size'
  | 'control-glyph-sm' | 'control-glyph-md' | 'control-glyph-lg'
  | 'control-dialog-header-padding-y' | 'control-dialog-header-padding-x'
  | 'control-dialog-padding'
  | 'control-switch-track-width' | 'control-switch-track-height'
  | 'control-switch-knob-size' | 'control-switch-inset'
  | 'control-slider-track-height' | 'control-slider-thumb-size' | 'control-slider-hit-height'
  | 'control-target-min' | 'control-row-min' | 'control-hit-extend'
  | 'control-disabled-opacity';

export type ThemeName = 'light' | 'dark';
export type ThemePreference = ThemeName;

export type DesignTokenName =
  | PrimitiveColorToken
  | SemanticColorToken
  | SpacingToken
  | BreakpointToken
  | TypographyToken
  | BorderToken
  | ShadowToken
  | TransitionToken
  | ZIndexToken
  | OpacityToken
  | ControlToken;

export type DesignToken = `--${DesignTokenName}`;
