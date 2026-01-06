import { Box, Text } from "ink";

export const ServerPlayers = ({ server }) => {
  if (!server.players) return;

  const headers = ["Player", "Frags", "Ping"];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box marginBottom={0}>
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
        <Box key={index}>
          <Text color="yellow">{String(row.name).padEnd(20)}</Text>
          <Text>{String(row.frags)}</Text>
          <Text>asdas</Text>
        </Box>
      ))}
    </Box>
  );
};
