import React, { useState, useEffect } from "react";
import { render, Text, Box, useInput } from "ink";
import { TitledBox, titleStyles } from "@mishieck/ink-titled-box";
import { Servers } from "./components/Servers";
import { withFullScreen, useScreenSize } from "fullscreen-ink";
import { ServerConfig } from "./components/ServerConfig";
import { ServerPlayers } from "./components/ServerPlayers";
import { ScrollView } from "ink-scroll-view";
import { ServerLog } from "./components/ServerLog";

const App = () => {
  const { height } = useScreenSize();
  const [selectedServer, setSelectedServer] = useState(null);
  const [loggedServer, setLoggedServer] = useState(null);

  return (
    <Box width={"100%"} height={height} flexDirection="row">
      <TitledBox
        borderStyle="single"
        titles={["Quake 2 Servers"]}
        titleStyle={titleStyles.bold}
        width={"100%"}
      >
        <Servers onChange={setSelectedServer} onSelect={setLoggedServer} />
      </TitledBox>
      {selectedServer && (
        <Box
          width={"100%"}
          borderColor="green"
          borderStyle="single"
          flexDirection="column"
        >
          <Box flexGrow={1} width={"100%"}>
            <ServerPlayers server={selectedServer} />
          </Box>
          <Box
            flexGrow={1}
            borderStyle="single"
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
          >
            <ScrollView>
              <ServerConfig server={selectedServer} />
            </ScrollView>
          </Box>
        </Box>
      )}
      {loggedServer && (
        <TitledBox
          borderStyle="single"
          titles={["Server Log"]}
          titleStyle={titleStyles.bold}
          width={"100%"}
        >
          <ScrollView>
            <ServerLog
              host={loggedServer.net.host}
              port={loggedServer.net.port}
            />
          </ScrollView>
        </TitledBox>
      )}
    </Box>
  );
};

// withFullScreen(<App />).start();
render(<App />);
