import React, { useState, useEffect } from "react";
import { render, Text, Box, useInput } from "ink";
import { TitledBox, titleStyles } from "@mishieck/ink-titled-box";
import { Servers } from "./components/Servers";
import { withFullScreen, useScreenSize } from "fullscreen-ink";
import { ServerConfig } from "./components/ServerConfig";
import { ServerPlayers } from "./components/ServerPlayers";
import { ScrollView } from "ink-scroll-view";

const App = () => {
  // const { height } = useScreenSize();
  const [selectedServer, setSelectedServer] = useState(null);

  return (
    <Box width={"100%"} height={25} flexDirection="row">
      <TitledBox
        borderStyle="single"
        titles={["Quake 2 Servers"]}
        titleStyle={titleStyles.bold}
        width={"100%"}
      >
        <Servers onSelect={setSelectedServer} />
      </TitledBox>
      {selectedServer && (
        <Box
          width={"100%"}
          borderColor="green"
          borderStyle="single"
          flexDirection="column"
        >
          <Box flexGrow={1}>
            <ScrollView height={5}>
              <ServerConfig server={selectedServer} />
            </ScrollView>
          </Box>
          <Box flexGrow={1}>
            <ServerPlayers server={selectedServer} />
          </Box>
        </Box>
      )}
    </Box>
  );
};

// withFullScreen(<App />).start();
render(<App />);
