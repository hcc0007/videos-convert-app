import "./global.css";
import { StatusBar } from "expo-status-bar";
import { PortalHost } from "@rn-primitives/portal";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ConvertScreen } from "./src/components/ConvertScreen";

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView className="flex-1 bg-paper">
        <ConvertScreen />
        <StatusBar style="dark" />
      </SafeAreaView>
      <PortalHost />
    </SafeAreaProvider>
  );
}
