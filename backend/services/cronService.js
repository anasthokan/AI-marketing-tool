import cron from "node-cron";

export const startScheduler = () => {
  cron.schedule("0 10 * * *", () => {
    console.log("Running daily post scheduler...");
  });
};