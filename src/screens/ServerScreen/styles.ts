import {StyleSheet} from 'react-native';
import {EdgeInsets} from 'react-native-safe-area-context';

import {Theme} from '../../utils/types';

export const createStyles = (theme: Theme, insets: EdgeInsets) =>
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    scroll: {
      flex: 1,
    },
    container: {
      flexGrow: 1,
      padding: theme.spacing.default,
      paddingBottom: theme.spacing.default + insets.bottom,
      gap: theme.spacing.default,
    },
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borders.default,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.default / 2,
      marginBottom: theme.spacing.default,
    },
    statusDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    statusText: {
      ...theme.fonts.titleMedium,
      color: theme.colors.onSurface,
    },
    muted: {
      ...theme.fonts.bodySmall,
      color: theme.colors.onSurfaceVariant,
    },
    hint: {
      ...theme.fonts.bodySmall,
      color: theme.colors.onSurfaceVariant,
      marginBottom: theme.spacing.default / 2,
    },
    error: {
      ...theme.fonts.bodySmall,
      color: theme.colors.error,
      marginTop: theme.spacing.default / 2,
    },
    label: {
      ...theme.fonts.labelLarge,
      color: theme.colors.onSurface,
    },
    addressBlock: {
      marginTop: theme.spacing.default,
      marginBottom: theme.spacing.default,
      gap: theme.spacing.default / 4,
    },
    addressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.default / 2,
      paddingVertical: theme.spacing.default / 2,
    },
    address: {
      ...theme.fonts.bodyMedium,
      color: theme.colors.primary,
      fontVariant: ['tabular-nums'],
    },
    lanLabel: {
      marginTop: theme.spacing.default / 2,
    },
    actions: {
      marginTop: theme.spacing.default / 2,
      marginBottom: theme.spacing.default / 2,
    },
    actionsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.default,
    },
    field: {
      marginTop: theme.spacing.default,
    },
    palPreview: {
      marginTop: theme.spacing.default / 2,
      marginBottom: 0,
    },
    palBlock: {
      marginBottom: theme.spacing.default,
    },
    logsToolbar: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
    },
    logItem: {
      borderTopWidth: 1,
      borderTopColor: theme.colors.surfaceVariant,
      paddingVertical: theme.spacing.default / 2,
    },
    logHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.default / 2,
    },
    logTime: {
      ...theme.fonts.bodySmall,
      color: theme.colors.onSurfaceVariant,
      fontVariant: ['tabular-nums'],
    },
    logBadge: {
      ...theme.fonts.labelSmall,
      minWidth: 34,
    },
    logSummary: {
      ...theme.fonts.bodySmall,
      color: theme.colors.onSurface,
      flex: 1,
    },
    logMeta: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.default,
      marginTop: theme.spacing.default / 4,
      paddingLeft: 58,
    },
    logDetail: {
      ...theme.fonts.bodySmall,
      color: theme.colors.onSurfaceVariant,
      fontFamily: 'monospace',
      backgroundColor: theme.colors.surfaceVariant,
      borderRadius: theme.borders.default,
      padding: theme.spacing.default / 2,
      marginTop: theme.spacing.default / 2,
    },
    modelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.default / 2,
    },
    modelText: {
      flex: 1,
      marginLeft: theme.spacing.default / 2,
    },
    modelName: {
      ...theme.fonts.bodyMedium,
      color: theme.colors.onSurface,
    },
    modelStatus: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.default,
      marginTop: theme.spacing.default / 2,
    },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.default,
      marginTop: theme.spacing.default,
    },
    switchText: {
      flex: 1,
    },
    endpointRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: theme.spacing.default / 2,
      paddingVertical: theme.spacing.default / 4,
    },
    resourceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.default,
      paddingVertical: theme.spacing.default / 4,
    },
    resourceValue: {
      ...theme.fonts.bodyMedium,
      color: theme.colors.onSurface,
      fontVariant: ['tabular-nums'],
    },
    method: {
      ...theme.fonts.labelMedium,
      color: theme.colors.primary,
      width: 48,
    },
    endpointPath: {
      ...theme.fonts.bodySmall,
      color: theme.colors.onSurface,
    },
    usageHint: {
      marginTop: theme.spacing.default,
      marginBottom: 0,
    },
    loader: {
      marginVertical: theme.spacing.default,
    },
  });
