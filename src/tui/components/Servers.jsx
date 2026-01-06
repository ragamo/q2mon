import { Box, Text, useInput } from "ink";
import { useState, useEffect, useRef } from "react";
import { ScrollList } from "ink-scroll-list";
import { ScrollBar } from "../ui/ScrollBar";
import { useScreenSize } from "fullscreen-ink";
import { getServerStatus } from "../../libs/q2status";

const fetchServersData = async () => {
  const response = await fetch("http://q2servers.com/?raw=1");
  const data = await response.text();
  const servers = data.split("\n");

  const statuses = servers
    .map((server) => {
      const [host, port] = server.split(":");
      if (!host || !port) return null;
      return getServerStatus(host, parseInt(port));
    })
    .filter(Boolean);

  const resolved = await Promise.allSettled(statuses);
  return resolved.map((status) => status.value);
};

export const Servers = ({ onChange, onSelect }) => {
  const { height } = useScreenSize();
  const [loading, setLoading] = useState(true);
  const [servers, setServers] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const fetchServers = async () => {
      const statuses = await fetchServersData();
      const filteredStatuses = statuses.filter(Boolean);
      setServers(filteredStatuses);
      setLoading(false);
      if (onChange) {
        onChange(filteredStatuses[0]);
      }
    };
    fetchServers();
  }, []);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, servers.length - 1));
    }
    if (input === "g") {
      setSelectedIndex(0); // Jump to first
    }
    if (input === "G") {
      setSelectedIndex(servers.length - 1); // Jump to last
    }
    if (key.return) {
      if (onSelect) {
        onSelect(servers[selectedIndex]);
        return;
      }
    }
    if (onChange) {
      onChange(servers[selectedIndex]);
    }
  });

  return (
    <Box flexGrow={1} flexDirection="row" marginTop={1}>
      {loading ? (
        <Text>Loading...</Text>
      ) : (
        <>
          <ScrollList selectedIndex={selectedIndex}>
            {servers.map((server, index) => (
              <>
                <Text
                  key={index}
                  color={selectedIndex === index ? "green" : "white"}
                >
                  {server.config.hostname}
                </Text>
              </>
            ))}
          </ScrollList>
          <ScrollBar
            placement="inset"
            style="block"
            contentHeight={servers.length}
            viewportHeight={height}
            scrollOffset={selectedIndex}
          />
        </>
      )}
    </Box>
  );
};
