import { createProjectClient } from "@mzon7/zon-incubator-sdk";

export const PROJECT_PREFIX = "back_in_play_";
export const { supabase, dbTable } = createProjectClient(PROJECT_PREFIX);
