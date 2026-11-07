import React, {useContext, useEffect, useState} from 'react';
import {ScrollView, TouchableOpacity, View} from 'react-native';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Button,
  Card,
  RadioButton,
  Switch,
  Text,
  TextInput,
} from 'react-native-paper';
import {observer} from 'mobx-react';
import DeviceInfo from 'react-native-device-info';
import Clipboard from '@react-native-clipboard/clipboard';

import {CopyIcon} from '../../assets/icons';
import {Dropdown} from '../../components/ui';
import {useTheme} from '../../hooks';
import {L10nContext} from '../../utils';
import {formatBytes} from '../../utils/formatters';
import {localServerStore} from '../../store';

import {ServerLogList} from './ServerLogList';
import {createStyles} from './styles';

export const ServerScreen: React.FC = observer(() => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const l10n = useContext(L10nContext);
  const styles = createStyles(theme, insets);

  const [portText, setPortText] = useState(String(localServerStore.port));
  const [portError, setPortError] = useState<string | null>(null);
  const [lanIp, setLanIp] = useState<string>('');
  const port = localServerStore.port;
  const isRunning = localServerStore.running;
  const allowLan = localServerStore.allowLan;

  useEffect(() => {
    setPortText(String(port));
  }, [port]);

  useEffect(() => {
    let cancelled = false;
    DeviceInfo.getIpAddress()
      .then(ip => {
        if (!cancelled) {
          setLanIp(ip && ip !== 'unknown' ? ip : '');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLanIp('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [allowLan, isRunning]);

  const handleStart = async () => {
    const parsed = Number(portText.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setPortError(l10n.server.portInvalid);
      return;
    }
    setPortError(null);
    localServerStore.setPort(parsed);
    await localServerStore.startServer();
  };

  const lanUrl = lanIp ? `http://${lanIp}:${localServerStore.port}` : null;
  const localUrl = `http://127.0.0.1:${localServerStore.port}`;
  const selectedModel = localServerStore.selectedModel;
  const canEdit = !localServerStore.running && !localServerStore.starting;

  const copyAddress = (value: string) => {
    Clipboard.setString(value);
  };

  const renderResource = (label: string, value: string) => (
    <View style={styles.resourceRow} key={label}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.resourceValue}>{value}</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}>
        <Card style={styles.card}>
          <Card.Title title={l10n.server.statusTitle} />
          <Card.Content>
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor: localServerStore.running
                      ? theme.colors.primary
                      : theme.colors.outline,
                  },
                ]}
              />
              <Text style={styles.statusText}>
                {localServerStore.starting || localServerStore.loadingModel
                  ? l10n.server.starting
                  : localServerStore.running
                    ? l10n.server.running
                    : l10n.server.stopped}
              </Text>
            </View>

            {localServerStore.generating ? (
              <Text style={styles.muted}>
                {l10n.server.generatingStatus
                  .replace(
                    '{{tokens}}',
                    String(localServerStore.generatedTokens),
                  )
                  .replace(
                    '{{rate}}',
                    localServerStore.generationRate.toFixed(1),
                  )}
              </Text>
            ) : localServerStore.busy ? (
              <Text style={styles.muted}>{l10n.server.busy}</Text>
            ) : localServerStore.running ? (
              <Text style={styles.muted}>{l10n.server.idleStatus}</Text>
            ) : null}

            {localServerStore.error ? (
              <Text style={styles.error}>{localServerStore.error}</Text>
            ) : null}

            {!localServerStore.supported ? (
              <Text style={styles.muted}>{l10n.server.unsupported}</Text>
            ) : null}

            <View style={styles.addressBlock}>
              <Text style={styles.label}>{l10n.server.localUrl}</Text>
              <TouchableOpacity
                style={styles.addressRow}
                onPress={() => copyAddress(localUrl)}>
                <Text selectable style={styles.address}>
                  {localUrl}
                </Text>
                <CopyIcon
                  width={18}
                  height={18}
                  stroke={theme.colors.onSurfaceVariant}
                />
              </TouchableOpacity>

              {localServerStore.allowLan ? (
                <>
                  <Text style={[styles.label, styles.lanLabel]}>
                    {l10n.server.lanUrl}
                  </Text>
                  {lanUrl ? (
                    <TouchableOpacity
                      style={styles.addressRow}
                      onPress={() => copyAddress(lanUrl)}>
                      <Text selectable style={styles.address}>
                        {lanUrl}
                      </Text>
                      <CopyIcon
                        width={18}
                        height={18}
                        stroke={theme.colors.onSurfaceVariant}
                      />
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.muted}>{l10n.server.noLanAddress}</Text>
                  )}
                </>
              ) : null}
            </View>

            <View style={styles.actions}>
              <View style={styles.actionsRow}>
                {localServerStore.running ? (
                  <>
                    <Button
                      mode="contained"
                      onPress={() => localServerStore.stopServer()}
                      testID="server-stop-button">
                      {l10n.server.stop}
                    </Button>
                    <Button
                      mode="outlined"
                      onPress={() => localServerStore.stopServerAndUnload()}
                      testID="server-stop-unload-button">
                      {l10n.server.stopAndUnload}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      mode="contained"
                      onPress={handleStart}
                      disabled={
                        !localServerStore.supported ||
                        localServerStore.starting ||
                        localServerStore.loadingModel ||
                        localServerStore.availableModels.length === 0
                      }
                      loading={
                        localServerStore.starting ||
                        localServerStore.loadingModel
                      }
                      testID="server-start-button">
                      {l10n.server.start}
                    </Button>
                    {localServerStore.modelLoaded ? (
                      <Button
                        mode="text"
                        onPress={() => localServerStore.unloadModel()}
                        testID="server-unload-button">
                        {l10n.server.unloadModel}
                      </Button>
                    ) : null}
                  </>
                )}
              </View>
            </View>

            {localServerStore.requestCount > 0 ? (
              <Text style={styles.muted}>
                {l10n.server.requests.replace(
                  '{{count}}',
                  String(localServerStore.requestCount),
                )}
              </Text>
            ) : null}
          </Card.Content>
        </Card>

        <Card style={styles.card}>
          <Card.Title title={l10n.server.resourcesTitle} />
          <Card.Content>
            {isRunning ? (
              <>
                {renderResource(
                  l10n.server.resourceCpu,
                  `${localServerStore.cpuPercent.toFixed(0)}%`,
                )}
                {renderResource(
                  l10n.server.resourceAppMemory,
                  formatBytes(localServerStore.processMemoryBytes, 1),
                )}
                {renderResource(
                  l10n.server.resourceSystemMemory,
                  `${formatBytes(
                    localServerStore.systemMemoryUsedBytes,
                    1,
                  )} / ${formatBytes(
                    localServerStore.systemMemoryTotalBytes,
                    1,
                  )}`,
                )}
                {renderResource(
                  l10n.server.resourceBattery,
                  `${localServerStore.batteryLevel.toFixed(
                    0,
                  )}% · ${localServerStore.batteryTempC.toFixed(1)} °C`,
                )}
                {renderResource(
                  l10n.server.resourceTraffic,
                  `↓ ${formatBytes(
                    localServerStore.trafficIn,
                    1,
                  )} · ↑ ${formatBytes(localServerStore.trafficOut, 1)}`,
                )}
              </>
            ) : (
              <Text style={styles.muted}>{l10n.server.resourcesIdle}</Text>
            )}
          </Card.Content>
        </Card>

        <Card style={styles.card}>
          <Card.Title title={l10n.server.configurationTitle} />
          <Card.Content>
            <View style={styles.palBlock}>
              <Text style={styles.label}>{l10n.server.palTitle}</Text>
              <Text style={styles.hint}>{l10n.server.palHint}</Text>
              <Dropdown
                testID="server-pal-select"
                value={localServerStore.palId ?? '__none__'}
                options={[
                  {value: '__none__', label: l10n.server.palNone},
                  ...localServerStore.availablePals.map(pal => ({
                    value: pal.id,
                    label: pal.name,
                  })),
                ]}
                onChange={value =>
                  localServerStore.selectPal(
                    value === '__none__' ? undefined : value,
                  )
                }
                disabled={
                  localServerStore.starting || localServerStore.loadingModel
                }
              />
              {localServerStore.systemPrompt ? (
                <Text
                  style={[styles.hint, styles.palPreview]}
                  numberOfLines={2}>
                  {l10n.server.palPromptPreview.replace(
                    '{{preview}}',
                    localServerStore.systemPrompt,
                  )}
                </Text>
              ) : null}
              <Text style={styles.muted}>
                {l10n.server.contextSize.replace(
                  '{{size}}',
                  String(localServerStore.contextSize),
                )}
              </Text>
              {localServerStore.contextReloadPending ? (
                <Text style={styles.error}>
                  {l10n.server.contextReloadPending.replace(
                    '{{configured}}',
                    String(localServerStore.configuredContextSize),
                  )}
                </Text>
              ) : null}
              {localServerStore.palRequestedTokens !== undefined &&
              localServerStore.palRequestedTokens >
                localServerStore.contextSize ? (
                <Text style={styles.error}>
                  {l10n.server.palTokensWarning
                    .replace(
                      '{{tokens}}',
                      String(localServerStore.palRequestedTokens),
                    )
                    .replace(
                      '{{context}}',
                      String(localServerStore.contextSize),
                    )}
                </Text>
              ) : null}
            </View>

            <Text style={styles.label}>{l10n.server.modelTitle}</Text>
            <Text style={styles.hint}>{l10n.server.modelHint}</Text>

            {localServerStore.availableModels.length === 0 ? (
              <Text style={styles.muted}>{l10n.server.noModels}</Text>
            ) : (
              localServerStore.availableModels.map(model => {
                const selected = selectedModel?.id === model.id;
                return (
                  <TouchableOpacity
                    key={model.id}
                    style={styles.modelRow}
                    disabled={!canEdit}
                    onPress={() => localServerStore.selectModel(model.id)}
                    testID={`server-model-${model.id}`}>
                    <RadioButton.Android
                      value={model.id}
                      status={selected ? 'checked' : 'unchecked'}
                      onPress={() => localServerStore.selectModel(model.id)}
                      disabled={!canEdit}
                    />
                    <View style={styles.modelText}>
                      <Text style={styles.modelName}>{model.name}</Text>
                      <Text style={styles.muted}>{model.author}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}

            <View style={styles.modelStatus}>
              <Text style={styles.muted}>
                {selectedModel
                  ? localServerStore.modelLoaded
                    ? l10n.server.loaded
                    : l10n.server.notLoaded
                  : ''}
              </Text>
              {selectedModel && !localServerStore.modelLoaded ? (
                <Button
                  mode="outlined"
                  compact
                  onPress={() => localServerStore.loadSelectedModel()}
                  disabled={
                    !canEdit ||
                    localServerStore.loadingModel ||
                    localServerStore.running
                  }
                  loading={localServerStore.loadingModel}
                  testID="server-load-model-button">
                  {l10n.server.loadModel}
                </Button>
              ) : null}
            </View>

            <View style={styles.field}>
              <TextInput
                mode="outlined"
                label={l10n.server.port}
                value={portText}
                onChangeText={value => {
                  setPortText(value);
                  setPortError(null);
                }}
                keyboardType="number-pad"
                disabled={!canEdit}
                error={!!portError}
                testID="server-port-input"
              />
              {portError ? <Text style={styles.error}>{portError}</Text> : null}
            </View>

            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.label}>{l10n.server.allowLanTitle}</Text>
                <Text style={styles.hint}>
                  {l10n.server.allowLanDescription}
                </Text>
              </View>
              <Switch
                value={localServerStore.allowLan}
                onValueChange={value => localServerStore.setAllowLan(value)}
                disabled={!canEdit}
                testID="server-lan-switch"
              />
            </View>
          </Card.Content>
        </Card>

        <Card style={styles.card}>
          <Card.Title title={l10n.server.endpointsTitle} />
          <Card.Content>
            {[
              {
                method: 'GET',
                path: '/v1/models',
                label: l10n.server.modelsEndpoint,
              },
              {
                method: 'POST',
                path: '/v1/chat/completions',
                label: l10n.server.chatEndpoint,
              },
              {
                method: 'POST',
                path: '/v1/completions',
                label: l10n.server.completionsEndpoint,
              },
            ].map(endpoint => (
              <View key={endpoint.path} style={styles.endpointRow}>
                <Text style={styles.method}>{endpoint.method}</Text>
                <Text selectable style={styles.endpointPath}>
                  {endpoint.path}
                </Text>
                <Text style={styles.muted}>{endpoint.label}</Text>
              </View>
            ))}
            <Text style={[styles.hint, styles.usageHint]}>
              {l10n.server.usageHint}
            </Text>
          </Card.Content>
        </Card>

        <Card style={styles.card}>
          <Card.Title title={l10n.server.logsTitle} />
          <Card.Content>
            <ServerLogList
              logs={localServerStore.logs}
              onClear={() => localServerStore.clearLogs()}
            />
          </Card.Content>
        </Card>

        {localServerStore.loadingModel ? (
          <ActivityIndicator style={styles.loader} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
});
