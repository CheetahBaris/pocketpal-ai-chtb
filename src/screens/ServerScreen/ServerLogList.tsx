import React, {useContext, useState} from 'react';
import {TouchableOpacity, View} from 'react-native';
import {Button, Text} from 'react-native-paper';

import {L10nContext} from '../../utils';
import {useTheme} from '../../hooks';
import type {
  ServerLogEntry,
  ServerLogKind,
} from '../../services/localServer/types';

import {createStyles} from './styles';

interface ServerLogListProps {
  logs: ServerLogEntry[];
  onClear: () => void;
}

const formatTime = (at: number) => new Date(at).toTimeString().slice(0, 8);

export const ServerLogList: React.FC<ServerLogListProps> = ({
  logs,
  onClear,
}) => {
  const theme = useTheme();
  const l10n = useContext(L10nContext);
  const styles = createStyles(theme, {top: 0, bottom: 0, left: 0, right: 0});
  const [expanded, setExpanded] = useState<string | null>(null);

  const toolbar = (
    <View style={styles.logsToolbar}>
      <Button
        mode="text"
        compact
        onPress={onClear}
        disabled={logs.length === 0}
        testID="server-log-clear">
        {l10n.server.logsClear}
      </Button>
    </View>
  );

  if (logs.length === 0) {
    return (
      <View testID="server-log-list">
        {toolbar}
        <Text style={styles.muted}>{l10n.server.logsEmpty}</Text>
      </View>
    );
  }

  const badgeLabel: Record<ServerLogKind, string> = {
    request: l10n.server.logRequest,
    response: l10n.server.logResponse,
    error: l10n.server.logError,
    lifecycle: l10n.server.logLifecycle,
  };

  const badgeColor: Record<ServerLogKind, string> = {
    request: theme.colors.primary,
    response: theme.colors.onSurfaceVariant,
    error: theme.colors.error,
    lifecycle: theme.colors.outline,
  };

  return (
    <View testID="server-log-list">
      {toolbar}
      {logs.slice(0, 50).map(entry => {
        const isOpen = expanded === entry.id;
        return (
          <View key={entry.id} style={styles.logItem}>
            <TouchableOpacity
              onPress={() => setExpanded(isOpen ? null : entry.id)}
              testID={`server-log-${entry.id}`}>
              <View style={styles.logHeader}>
                <Text style={styles.logTime}>{formatTime(entry.at)}</Text>
                <Text
                  style={[styles.logBadge, {color: badgeColor[entry.kind]}]}>
                  {badgeLabel[entry.kind]}
                </Text>
                <Text style={styles.logSummary} numberOfLines={1}>
                  {entry.summary ?? ''}
                </Text>
              </View>
              {entry.status || entry.durationMs ? (
                <View style={styles.logMeta}>
                  {entry.status ? (
                    <Text style={styles.muted}>{entry.status}</Text>
                  ) : null}
                  {entry.durationMs ? (
                    <Text style={styles.muted}>
                      {l10n.server.logDuration.replace(
                        '{{seconds}}',
                        (entry.durationMs / 1000).toFixed(1),
                      )}
                    </Text>
                  ) : null}
                  {entry.promptTokens !== undefined ||
                  entry.completionTokens !== undefined ? (
                    <Text style={styles.muted}>
                      {l10n.server.logTokens
                        .replace('{{prompt}}', String(entry.promptTokens ?? 0))
                        .replace(
                          '{{completion}}',
                          String(entry.completionTokens ?? 0),
                        )}
                    </Text>
                  ) : null}
                  {entry.messages !== undefined ? (
                    <Text style={styles.muted}>
                      {l10n.server.logMessages.replace(
                        '{{count}}',
                        String(entry.messages),
                      )}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </TouchableOpacity>
            {isOpen && entry.detail ? (
              <Text selectable style={styles.logDetail}>
                {entry.detail}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
};
