import { useParams, Navigate } from "react-router-dom";

/** /player/:playerSlug/return → redirects to /:playerSlug-return-date (canonical SEO URL) */
export default function PlayerReturnAliasPage() {
  const { playerSlug } = useParams<{ playerSlug: string }>();
  return <Navigate to={`/${playerSlug}-return-date`} replace />;
}
