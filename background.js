chrome.sidePanel.setPanelBehavior({
  openPanelOnActionClick: true
}).catch((error) => {
  console.error("Error configurando Side Panel:", error);
});
