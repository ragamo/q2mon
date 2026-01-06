import { Box, Text } from "ink";

export const ServerPlayers = ({ server }) => {
  if (!server.players) return;

  const headers = ["Player", "Frags", "Ping"];

  return (
    <Box flexDirection="column" width={"100%"}>
      <Box marginBottom={0} justifyContent="space-between">
        <Text color="cyan" bold>
          {headers[0]}
        </Text>
        <Text color="cyan" bold>
          {headers[1]}
        </Text>
        <Text color="cyan" bold>
          {headers[2]}
        </Text>
      </Box>

      {server.players.map((row, index) => (
        <Box key={index} justifyContent="space-between">
          <Text color="yellow">{String(row.name).padEnd(20)}</Text>
          <Text>{String(row.frags)}</Text>
          <Text>{String(row.ping)}</Text>
        </Box>
      ))}
    </Box>
  );
};
