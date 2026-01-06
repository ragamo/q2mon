import { Box, Text } from "ink";

export const ServerConfig = ({ server }) => {
  if (!server.config) return;

  const config = Object.entries(server.config).map(([key, value]) => ({
    key,
    value,
  }));

  const headers = ["Config", "Value"];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          {headers[0].padEnd(20)}
        </Text>
        <Text color="cyan" bold>
          {headers[1]}
        </Text>
      </Box>

      {config.map((row, index) => (
        <Box key={index}>
          <Text color="yellow">{String(row.key).padEnd(20)}</Text>
          <Text>{String(row.value)}</Text>
        </Box>
      ))}
    </Box>
  );
};
