import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { ScrollablePage } from "@pocket/ui";

const ROWS = Array.from({ length: 18 }, (_, index) => index);

function App() {
  return (
    <Screen>
      <ScrollablePage>
        <View class="flex-col w-full p-4 gap-2">
          <Text>SCROLL_TOP</Text>
          <Text>SCROLL_MIDDLE</Text>
          {ROWS.map((index) => (
            <View style={{ height: 64 }}>
              <Text>{`SCROLL_ROW_${index}`}</Text>
            </View>
          ))}
          <Text>SCROLL_BOTTOM</Text>
        </View>
      </ScrollablePage>
    </Screen>
  );
}

mount(() => <App />);
