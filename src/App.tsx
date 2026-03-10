import { Routes, Route, Navigate } from "react-router-dom";
import { AuthCallback } from "@mzon7/zon-incubator-sdk/auth";
import { supabase } from "./lib/supabase";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import HomePage from "./features/home-page-injury-snapshots/components/HomePage";

export default function App() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route
        path="/auth/callback"
        element={<AuthCallback supabase={supabase} redirectTo="/" />}
      />

      {/* Placeholder routes — will be filled in subsequent feature steps */}
      <Route path="/latest-injuries" element={<HomePage />} />
      <Route path="/return-tracker" element={<HomePage />} />
      <Route path="/search" element={<HomePage />} />
      <Route path="/league/:leagueSlug" element={<HomePage />} />
      <Route path="/player/:playerSlug" element={<HomePage />} />
      <Route path="/injury-type/:injuryTypeSlug" element={<HomePage />} />

      {/* Default redirect */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
